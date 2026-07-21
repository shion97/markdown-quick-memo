"""Markdown Quick Memo のTkinter GUI。"""

from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
import os
from pathlib import Path
from threading import Thread
import tkinter as tk
from tkinter import filedialog, font as tkfont, messagebox, ttk
import webbrowser

from .document import read_markdown, write_markdown
from .font_support import (
    JAPANESE_FONT_FAMILY,
    LATIN_FONT_FAMILY,
    MATH_SOURCE_FONT_FAMILY,
    MONOSPACE_FONT_FAMILY,
    build_font_runs,
    is_japanese_character,
    register_bundled_fonts,
)
from .markdown_styler import (
    LinkReference,
    ListMarker,
    MarkdownAnalysis,
    MathExpression,
    TableBlock,
    analyze_markdown,
)
from .math_renderer import preload_math_renderer, render_math_png


APP_NAME = "Markdown Quick Memo"
DEFAULT_GEOMETRY = "760x620"
RENDER_DELAY_MS = 140
EDITOR_SCROLL_PIXELS_PER_NOTCH = 48
WINDOWS_MOUSE_WHEEL_DELTA = 120
LIST_BULLET_FONT_SIZE = 9
LIST_HOLLOW_BULLET_FONT_SIZE = 6
LIST_NUMBER_FONT_SIZE = 10
TABLE_LINE_COLOR = "#94a3b8"
TABLE_LINE_WIDTH = 1
TABLE_STRONG_LINE_WIDTH = TABLE_LINE_WIDTH * 2
HEADING_FONT_SIZES = (22, 19, 17, 15, 13, 12)
INLINE_MATH_FONT_SIZE = 8
DISPLAY_MATH_FONT_SIZE = 15
INLINE_MATH_DISPLAY_DPI = 120
INLINE_MATH_RENDER_DPI = 240
DISPLAY_MATH_DPI = 150
INLINE_MATH_TOP_PADDING = 4
DISPLAY_MATH_VERTICAL_PADDING_POINTS = 2.0
MATH_PRELOAD_DELAY_MS = 100
SCRIPT_FONT_TAG_DELAY_MS = 25
MAX_TABLE_DIMENSION = 100
OPAQUE_WINDOW_ALPHA = 1.0
TRANSLUCENT_WINDOW_ALPHA = 0.6


def build_table_template(row_count: int, column_count: int) -> str:
    """Create a Markdown table whose visible cells are filled with ``q``."""

    if not 1 <= row_count <= MAX_TABLE_DIMENSION:
        raise ValueError(f"行数は1から{MAX_TABLE_DIMENSION}までで指定してください。")
    if not 1 <= column_count <= MAX_TABLE_DIMENSION:
        raise ValueError(f"列数は1から{MAX_TABLE_DIMENSION}までで指定してください。")

    value_row = f"| {' | '.join('q' for _ in range(column_count))} |"
    delimiter_row = f"| {' | '.join('---' for _ in range(column_count))} |"
    return "\n".join([value_row, delimiter_row, *([value_row] * (row_count - 1))])


@dataclass(slots=True)
class _DecorationRecord:
    start: int
    end: int
    decoration_type: str
    decoration: object
    start_mark: str
    end_mark: str
    widget: tk.Widget | None = None


class MarkdownQuickMemoApp:
    def __init__(self, root: tk.Tk, initial_path: Path | None = None) -> None:
        self.root = root
        register_bundled_fonts()
        self._latin_font_family = LATIN_FONT_FAMILY
        self._japanese_font_family = JAPANESE_FONT_FAMILY
        self._font_objects: list[tkfont.Font] = []
        self.current_path: Path | None = None
        self.dirty = False
        self.hide_markers = tk.BooleanVar(value=True)
        self.transparent_mode = tk.BooleanVar(value=False)
        self._render_job: str | None = None
        self._scroll_redraw_job: str | None = None
        self._last_cursor_line = 1
        self._analysis = MarkdownAnalysis()
        self._analysis_stale = False
        self._dynamic_link_tags: list[str] = []
        self._decoration_widgets: list[tk.Widget] = []
        self._decoration_records: list[_DecorationRecord] = []
        self._rendering = False
        self._last_editor_width = 0
        self._resize_job: str | None = None
        self._search_visible = False
        self._main_frame: ttk.Frame | None = None
        self.search_frame: ttk.Frame | None = None
        self.search_entry: ttk.Entry | None = None
        self._math_preload_job: str | None = None
        self._math_preload_thread: Thread | None = None
        self._script_font_tag_job: str | None = None
        self._script_font_tags_ready = False
        self._character_count = 0
        self._word_count = 0
        self._document_statistics_dirty = True

        self._configure_named_fonts()
        self._configure_window()
        self._build_widgets()
        self._configure_tags()
        self._bind_shortcuts()
        self.new_document(confirm=False)

        if initial_path is not None:
            self.open_path(initial_path)
        self.editor.focus_set()
        self._schedule_script_font_tag_configuration()
        self._schedule_math_preload()

    def _schedule_script_font_tag_configuration(self) -> None:
        if self._script_font_tags_ready or self._script_font_tag_job is not None:
            return
        self._script_font_tag_job = self.root.after(
            SCRIPT_FONT_TAG_DELAY_MS,
            self._configure_scheduled_script_font_tags,
        )

    def _configure_scheduled_script_font_tags(self) -> None:
        self._script_font_tag_job = None
        self._ensure_script_font_tags()

    def _schedule_math_preload(self) -> None:
        self._math_preload_job = self.root.after(MATH_PRELOAD_DELAY_MS, self._start_math_preload)

    def _start_math_preload(self) -> None:
        self._math_preload_job = None
        if self._math_preload_thread is not None and self._math_preload_thread.is_alive():
            return
        requests = (
            ("E=mc^2", INLINE_MATH_FONT_SIZE, INLINE_MATH_RENDER_DPI, 0.0),
            (
                r"\frac{a}{b}",
                DISPLAY_MATH_FONT_SIZE,
                DISPLAY_MATH_DPI,
                DISPLAY_MATH_VERTICAL_PADDING_POINTS,
            ),
            (
                r"\begin{pmatrix}a&b\\c&d\end{pmatrix}",
                DISPLAY_MATH_FONT_SIZE,
                DISPLAY_MATH_DPI,
                DISPLAY_MATH_VERTICAL_PADDING_POINTS,
            ),
        )
        self._math_preload_thread = Thread(
            target=preload_math_renderer,
            args=(requests,),
            name="mathtext-preload",
            daemon=True,
        )
        self._math_preload_thread.start()

    def _configure_window(self) -> None:
        self.root.title(APP_NAME)
        self.root.geometry(DEFAULT_GEOMETRY)
        self.root.minsize(480, 360)
        self.root.attributes("-alpha", OPAQUE_WINDOW_ALPHA)
        self.root.option_add("*tearOff", False)
        self.root.protocol("WM_DELETE_WINDOW", self.close)

    def _configure_named_fonts(self) -> None:
        for font_name in ("TkDefaultFont", "TkMenuFont", "TkCaptionFont", "TkSmallCaptionFont"):
            try:
                tkfont.nametofont(font_name).configure(family=self._japanese_font_family)
            except tk.TclError:
                continue

    def _build_widgets(self) -> None:
        self.root.rowconfigure(0, weight=1)
        self.root.columnconfigure(0, weight=1)

        main = ttk.Frame(self.root, padding=(10, 8, 10, 6))
        main.grid(row=0, column=0, sticky="nsew")
        main.rowconfigure(1, weight=1)
        main.columnconfigure(0, weight=1)
        self._main_frame = main

        header = ttk.Frame(main)
        header.grid(row=0, column=0, columnspan=2, sticky="ew", pady=(0, 7))
        header.columnconfigure(1, weight=1)
        ttk.Label(header, text=APP_NAME, style="Title.TLabel").grid(row=0, column=0, sticky="w")
        self.status_text = tk.StringVar()
        self.status_label = ttk.Label(header, textvariable=self.status_text, anchor="center")
        self.status_label.grid(row=0, column=1, sticky="ew", padx=10)
        ttk.Checkbutton(
            header,
            text="記号を隠す",
            variable=self.hide_markers,
            command=self.render_markdown,
        ).grid(row=0, column=2, sticky="e")

        editor_frame = ttk.Frame(main, style="Editor.TFrame", padding=1)
        editor_frame.grid(row=1, column=0, columnspan=2, sticky="nsew")
        editor_frame.rowconfigure(0, weight=1)
        editor_frame.columnconfigure(0, weight=1)

        self.editor = tk.Text(
            editor_frame,
            wrap="word",
            undo=True,
            autoseparators=True,
            maxundo=-1,
            padx=16,
            pady=14,
            borderwidth=0,
            highlightthickness=0,
            spacing1=2,
            spacing3=2,
        )
        scrollbar = ttk.Scrollbar(editor_frame, orient="vertical", command=self.editor.yview)
        self._editor_scrollbar = scrollbar
        self.editor.configure(yscrollcommand=self._on_editor_yview_changed)
        self.editor.grid(row=0, column=0, sticky="nsew")
        scrollbar.grid(row=0, column=1, sticky="ns")

        self._build_menu()
        style = ttk.Style(self.root)
        style.configure("Title.TLabel", font=(self._latin_font_family, 11, "bold"))

    def _ensure_search_widgets(self) -> tuple[ttk.Frame, ttk.Entry]:
        if self.search_frame is not None and self.search_entry is not None:
            return self.search_frame, self.search_entry
        if self._main_frame is None:
            raise RuntimeError("メイン画面が初期化されていません。")

        search_frame = ttk.Frame(self._main_frame, padding=(0, 6, 0, 0))
        search_frame.columnconfigure(1, weight=1)
        ttk.Label(search_frame, text="検索").grid(row=0, column=0, padx=(0, 6))
        search_entry = ttk.Entry(search_frame)
        search_entry.grid(row=0, column=1, sticky="ew")
        ttk.Button(
            search_frame,
            text="前へ",
            width=6,
            command=lambda: self.find_next(backwards=True),
        ).grid(row=0, column=2, padx=(6, 2))
        ttk.Button(search_frame, text="次へ", width=6, command=self.find_next).grid(
            row=0,
            column=3,
            padx=2,
        )
        ttk.Button(search_frame, text="閉じる", width=6, command=self.hide_search).grid(
            row=0,
            column=4,
            padx=(2, 0),
        )
        search_entry.bind("<KeyRelease>", lambda _event: self.highlight_search_matches())
        search_entry.bind("<Return>", self.find_next)
        search_entry.bind("<Shift-Return>", lambda _event: self.find_next(backwards=True))
        self.search_frame = search_frame
        self.search_entry = search_entry
        return search_frame, search_entry

    def _build_menu(self) -> None:
        menu = tk.Menu(self.root)
        file_menu = tk.Menu(menu)
        file_menu.add_command(label="新規", accelerator="Ctrl+N", command=self.new_document)
        file_menu.add_command(label="開く...", accelerator="Ctrl+O", command=self.open_document)
        file_menu.add_separator()
        file_menu.add_command(label="上書き保存", accelerator="Ctrl+S", command=self.save)
        file_menu.add_command(label="名前を付けて保存...", accelerator="Ctrl+Shift+S", command=self.save_as)
        file_menu.add_separator()
        file_menu.add_command(
            label="PDFに書き出す",
            accelerator="Ctrl+Shift+P",
            command=self.export_pdf,
        )
        file_menu.add_separator()
        file_menu.add_command(label="閉じる", accelerator="Ctrl+Q", command=self.close)
        menu.add_cascade(label="ファイル", menu=file_menu)

        edit_menu = tk.Menu(menu)
        edit_menu.add_command(label="元に戻す", accelerator="Ctrl+Z", command=lambda: self._edit_event("<<Undo>>"))
        edit_menu.add_command(label="やり直す", accelerator="Ctrl+Y", command=lambda: self._edit_event("<<Redo>>"))
        edit_menu.add_separator()
        edit_menu.add_command(label="検索", accelerator="Ctrl+F", command=self.show_search)
        edit_menu.add_command(label="表を挿入...", accelerator="Ctrl+T", command=self.show_table_dialog)
        edit_menu.add_separator()
        edit_menu.add_command(label="太字", accelerator="Ctrl+B", command=lambda: self.wrap_selection("**"))
        edit_menu.add_command(label="斜体", accelerator="Ctrl+I", command=lambda: self.wrap_selection("*"))
        edit_menu.add_command(label="取り消し線", accelerator="Ctrl+Shift+X", command=lambda: self.wrap_selection("~~"))
        edit_menu.add_separator()
        edit_menu.add_checkbutton(
            label="ウィンドウを半透明",
            accelerator="Ctrl+Shift+O",
            variable=self.transparent_mode,
            command=self._apply_window_opacity,
        )
        menu.add_cascade(label="編集", menu=edit_menu)
        self.root.configure(menu=menu)

    def _configure_tags(self) -> None:
        base = tkfont.nametofont("TkTextFont")
        base.configure(family=self._latin_font_family, size=11)
        bold = base.copy()
        bold.configure(weight="bold")
        italic = base.copy()
        italic.configure(slant="italic")
        bold_italic = base.copy()
        bold_italic.configure(weight="bold", slant="italic")
        mono = tkfont.Font(family=MONOSPACE_FONT_FAMILY, size=10)

        colors = {
            "foreground": "#20242b",
            "muted": "#6b7280",
            "accent": "#2563eb",
            "code_bg": "#f3f4f6",
            "quote": "#4b5563",
            "selection": "#bfdbfe",
        }
        self.editor.configure(
            font=base,
            foreground=colors["foreground"],
            background="#ffffff",
            insertbackground="#111827",
            selectbackground=colors["selection"],
            selectforeground="#111827",
        )
        for level, size in enumerate(HEADING_FONT_SIZES, start=1):
            heading_font = base.copy()
            heading_font.configure(size=size, weight="bold")
            self.editor.tag_configure(f"heading{level}", font=heading_font, spacing1=7, spacing3=3)
        self.editor.tag_configure("bold", font=bold)
        self.editor.tag_configure("italic", font=italic)
        self.editor.tag_configure("bold_italic", font=bold_italic)
        self.editor.tag_configure("strike", overstrike=True, foreground=colors["muted"])
        self.editor.tag_configure("inline_code", font=mono, background=colors["code_bg"])
        self.editor.tag_configure("code_block", font=mono, background=colors["code_bg"], lmargin1=12, lmargin2=12, spacing1=5, spacing3=5)
        code_language_font = mono.copy()
        code_language_font.configure(size=9, weight="bold")
        self.editor.tag_configure(
            "code_language", font=code_language_font, foreground=colors["muted"], background=colors["code_bg"]
        )
        self.editor.tag_configure("quote", foreground=colors["quote"], lmargin1=18, lmargin2=18)
        self.editor.tag_configure("quote_marker", foreground="#9ca3af", font=bold)
        self.editor.tag_configure("list_item", lmargin1=12, lmargin2=28)
        self.editor.tag_configure("list_marker", foreground=colors["foreground"], font=bold)
        self.editor.tag_configure("checkbox", foreground=colors["muted"])
        self.editor.tag_configure("checkbox_checked", foreground="#15803d", overstrike=True)
        self.editor.tag_configure("horizontal_rule", foreground=colors["muted"], justify="center")
        self.editor.tag_configure("table", font=mono, background="#f8fafc")
        self.editor.tag_configure("table_delimiter", font=mono, foreground=colors["muted"], background="#f8fafc")
        math_font = tkfont.Font(family=MATH_SOURCE_FONT_FAMILY, size=12)
        self.editor.tag_configure("math_inline", font=math_font, foreground="#4338ca")
        self.editor.tag_configure(
            "math_block", font=math_font, foreground="#4338ca", justify="center", spacing1=6, spacing3=6
        )
        self.editor.tag_configure("link", foreground=colors["accent"], underline=True)
        self.editor.tag_configure("image_reference", foreground="#7c3aed", underline=True)
        self.editor.tag_configure("marker", foreground="#9ca3af")
        self.editor.tag_configure("marker_hidden", elide=True)
        self.editor.tag_configure("current_line", background="#f8fafc")
        self.editor.tag_configure("search_match", background="#fde68a", foreground="#111827")
        self.editor.tag_configure("search_current", background="#fb923c", foreground="#111827")
        self.editor.tag_lower("current_line")

    def _create_font(
        self,
        family: str,
        size: int,
        *,
        weight: str = "normal",
        slant: str = "roman",
    ) -> tkfont.Font:
        font = tkfont.Font(root=self.root, family=family, size=size, weight=weight, slant=slant)
        self._font_objects.append(font)
        return font

    def _configure_script_font_tags(self) -> None:
        heading_sizes = HEADING_FONT_SIZES
        for script, family in (
            ("latin", self._latin_font_family),
            ("japanese", self._japanese_font_family),
        ):
            math_family = (
                MATH_SOURCE_FONT_FAMILY
                if script == "latin"
                else self._japanese_font_family
            )
            font_specs = {
                "body": self._create_font(family, 11),
                "bold": self._create_font(family, 11, weight="bold"),
                "italic": self._create_font(family, 11, slant="italic"),
                "bold_italic": self._create_font(family, 11, weight="bold", slant="italic"),
                "mono": self._create_font(
                    MONOSPACE_FONT_FAMILY if script == "latin" else self._japanese_font_family,
                    10,
                ),
                "mono_bold": self._create_font(
                    MONOSPACE_FONT_FAMILY if script == "latin" else self._japanese_font_family,
                    9,
                    weight="bold",
                ),
                "math": self._create_font(
                    math_family,
                    12,
                ),
            }
            for level, size in enumerate(heading_sizes, start=1):
                font_specs[f"math_heading{level}"] = self._create_font(math_family, size)
                font_specs[f"heading{level}"] = self._create_font(family, size, weight="bold")
                font_specs[f"heading{level}_italic"] = self._create_font(
                    family,
                    size,
                    weight="bold",
                    slant="italic",
                )
            for font_style, font in font_specs.items():
                self.editor.tag_configure(f"script_font_{script}_{font_style}", font=font)

    def _ensure_script_font_tags(self) -> None:
        if self._script_font_tags_ready:
            return
        if self._script_font_tag_job is not None:
            try:
                self.root.after_cancel(self._script_font_tag_job)
            except tk.TclError:
                pass
            self._script_font_tag_job = None
        self._configure_script_font_tags()
        self._script_font_tags_ready = True

    def _apply_script_fonts(self, text: str) -> None:
        if not text:
            return
        self._ensure_script_font_tags()
        for run in build_font_runs(text, self._analysis.spans):
            self.editor.tag_add(run.tag, f"1.0 + {run.start}c", f"1.0 + {run.end}c")

    def _bind_shortcuts(self) -> None:
        bindings = {
            "<Control-n>": self.new_document,
            "<Control-o>": self.open_document,
            "<Control-s>": self.save,
            "<Control-Shift-S>": self.save_as,
            "<Control-q>": self.close,
            "<Control-f>": self.show_search,
            "<Control-t>": self.show_table_dialog,
            "<Control-Shift-P>": self.export_pdf,
            "<Control-b>": lambda event=None: self.wrap_selection("**"),
            "<Control-i>": lambda event=None: self.wrap_selection("*"),
            "<Control-Shift-X>": lambda event=None: self.wrap_selection("~~"),
            "<Control-Shift-O>": self.toggle_window_transparency,
        }
        for sequence, callback in bindings.items():
            self.root.bind(sequence, callback)
        self.root.bind("<Control-y>", lambda event: self._edit_event("<<Redo>>"))
        self.root.bind("<Escape>", lambda event: self.hide_search() if self._search_visible else None)
        self.editor.bind("<<Modified>>", self._on_modified)
        self.editor.bind("<KeyRelease>", self._on_cursor_moved, add=True)
        self.editor.bind("<ButtonRelease-1>", self._on_cursor_moved, add=True)
        self.editor.bind("<Control-Button-1>", self._on_control_click, add=True)
        self.editor.bind("<Configure>", self._on_editor_resized, add=True)
        self.editor.bind("<MouseWheel>", self._forward_editor_mousewheel)

    @staticmethod
    def _break() -> str:
        return "break"

    def toggle_window_transparency(self, event: tk.Event | None = None) -> str | None:
        self.transparent_mode.set(not self.transparent_mode.get())
        self._apply_window_opacity()
        return self._break() if event is not None else None

    def _apply_window_opacity(self) -> None:
        alpha = TRANSLUCENT_WINDOW_ALPHA if self.transparent_mode.get() else OPAQUE_WINDOW_ALPHA
        try:
            self.root.attributes("-alpha", alpha)
        except tk.TclError:
            self.transparent_mode.set(False)
            self._update_title_and_status(message="この環境では透過表示を使用できません")
            return
        self._update_title_and_status()

    def _edit_event(self, event_name: str) -> str:
        try:
            self.editor.event_generate(event_name)
        except tk.TclError:
            pass
        return self._break()

    def _on_modified(self, _event: tk.Event | None = None) -> None:
        if self._rendering:
            self.editor.edit_modified(False)
            return
        if not self.editor.edit_modified():
            return
        self.dirty = True
        self._analysis_stale = True
        self._document_statistics_dirty = True
        self.editor.edit_modified(False)
        self._schedule_render()
        self._update_title_and_status()

    def _on_cursor_moved(self, _event: tk.Event | None = None) -> None:
        line = int(self.editor.index("insert").split(".")[0])
        if line != self._last_cursor_line:
            previous_line = self._last_cursor_line
            self._last_cursor_line = line
            if self._analysis_stale:
                self._highlight_current_line()
                self._update_title_and_status()
            else:
                self._refresh_active_line(previous_line)
        else:
            self._highlight_current_line()
            self._update_title_and_status()

    def _schedule_render(self) -> None:
        if self._render_job is not None:
            self.root.after_cancel(self._render_job)
        self._render_job = self.root.after(RENDER_DELAY_MS, self.render_markdown)

    def _on_editor_resized(self, event: tk.Event) -> None:
        if event.width == self._last_editor_width:
            return
        self._last_editor_width = event.width
        if self._resize_job is not None:
            self.root.after_cancel(self._resize_job)
        self._resize_job = self.root.after(180, self._render_after_resize)

    def _render_after_resize(self) -> None:
        self._resize_job = None
        self.render_markdown()

    def render_markdown(self) -> None:
        if self._rendering:
            return
        self._rendering = True
        self._render_job = None
        try:
            insert_offset = len(self.editor.get("1.0", "insert"))
            selection_offsets = self._selection_offsets()
            yview = self.editor.yview()
            self._clear_decorations()

            text = self.editor.get("1.0", "end-1c")
            self._analysis = analyze_markdown(text)
            self._analysis_stale = False
            self._set_document_statistics(text)
            insert_index = f"1.0 + {insert_offset}c"

            for tag in self.editor.tag_names():
                if tag not in {"sel", "search_match", "search_current"}:
                    self.editor.tag_remove(tag, "1.0", "end")
            for tag in self._dynamic_link_tags:
                self.editor.tag_delete(tag)
            self._dynamic_link_tags.clear()

            active_line_start = self.editor.index(f"{insert_index} linestart")
            active_line_end = self.editor.index(f"{insert_index} lineend +1c")
            active_line_start_offset = len(self.editor.get("1.0", active_line_start))
            active_line_end_offset = len(self.editor.get("1.0", active_line_end))
            for span in self._analysis.spans:
                if span.start >= span.end:
                    continue
                start = f"1.0 + {span.start}c"
                end = f"1.0 + {span.end}c"
                self.editor.tag_add(span.tag, start, end)
                if span.concealable:
                    self.editor.tag_add("marker_concealable", start, end)
                if span.concealable and self.hide_markers.get():
                    if self.editor.compare(end, "<=", active_line_start) or self.editor.compare(start, ">=", active_line_end):
                        self.editor.tag_add("marker_hidden", start, end)

            self._apply_script_fonts(text)

            for number, link in enumerate(self._analysis.links):
                tag = f"dynamic_link_{number}"
                start = f"1.0 + {link.start}c"
                end = f"1.0 + {link.end}c"
                self.editor.tag_add(tag, start, end)
                self.editor.tag_configure(tag, foreground="#7c3aed" if link.is_image else "#2563eb", underline=True)
                self.editor.tag_bind(tag, "<Enter>", lambda event: self.editor.configure(cursor="hand2"))
                self.editor.tag_bind(tag, "<Leave>", lambda event: self.editor.configure(cursor="xterm"))
                self._dynamic_link_tags.append(tag)

            self.editor.mark_set("insert", insert_index)
            if selection_offsets:
                start_offset, end_offset = selection_offsets
                self.editor.tag_add("sel", f"1.0 + {start_offset}c", f"1.0 + {end_offset}c")
            self._render_block_decorations(
                insert_offset,
                active_line_start_offset,
                active_line_end_offset,
            )
            if yview:
                self.editor.yview_moveto(yview[0])
            self._last_cursor_line = int(self.editor.index("insert").split(".")[0])
            self._highlight_current_line()
            self._update_title_and_status()
            self.editor.edit_modified(False)
        finally:
            self._rendering = False

    def _refresh_active_line(self, previous_line: int) -> None:
        if self._rendering:
            return
        self._rendering = True
        try:
            yview = self.editor.yview()
            insert_offset = len(self.editor.get("1.0", "insert"))
            active_line_start_index = self.editor.index("insert linestart")
            active_line_end_index = self.editor.index("insert lineend +1c")
            active_line_start = len(self.editor.get("1.0", active_line_start_index))
            active_line_end = len(self.editor.get("1.0", active_line_end_index))
            self._sync_block_decorations(
                insert_offset,
                active_line_start,
                active_line_end,
            )
            self._refresh_marker_visibility(
                previous_line,
                active_line_start_index,
                active_line_end_index,
            )
            if yview:
                self.editor.yview_moveto(yview[0])
            self._highlight_current_line()
            self._update_title_and_status()
            self.editor.edit_modified(False)
        finally:
            self._rendering = False

    def _refresh_marker_visibility(
        self,
        previous_line: int,
        active_line_start: str,
        active_line_end: str,
    ) -> None:
        if not self.hide_markers.get():
            return
        previous_line_start = f"{previous_line}.0"
        previous_line_end = f"{previous_line}.0 lineend +1c"
        self._set_marker_visibility(previous_line_start, previous_line_end, hidden=True)
        self._set_marker_visibility(active_line_start, active_line_end, hidden=False)

    def _set_marker_visibility(self, start_index: str, end_index: str, *, hidden: bool) -> None:
        marker_range = self.editor.tag_nextrange(
            "marker_concealable",
            start_index,
            end_index,
        )
        while marker_range:
            start, end = marker_range
            if hidden:
                self.editor.tag_add("marker_hidden", start, end)
            else:
                self.editor.tag_remove("marker_hidden", start, end)
            marker_range = self.editor.tag_nextrange(
                "marker_concealable",
                end,
                end_index,
            )

    def _selection_offsets(self) -> tuple[int, int] | None:
        selection = self._selection_indices()
        if selection is None:
            return None
        return (
            len(self.editor.get("1.0", selection[0])),
            len(self.editor.get("1.0", selection[1])),
        )

    def _clear_decorations(self) -> None:
        for record in sorted(self._decoration_records, key=lambda item: item.start, reverse=True):
            widget = record.widget
            if widget is None:
                continue
            try:
                window_index = self.editor.index(str(widget))
                self.editor.delete(window_index)
            except tk.TclError:
                pass
            try:
                widget.destroy()
            except tk.TclError:
                pass
            record.widget = None
        for record in self._decoration_records:
            try:
                self.editor.mark_unset(record.start_mark, record.end_mark)
            except tk.TclError:
                pass
        self._decoration_widgets.clear()
        self._decoration_records.clear()

    def _render_block_decorations(
        self,
        insert_offset: int,
        active_line_start: int,
        active_line_end: int,
    ) -> None:
        if not self.hide_markers.get():
            return
        decorations = self._collect_block_decorations()
        for number, (start, end, decoration_type, decoration) in enumerate(decorations):
            start_mark = f"_decoration_start_{number}"
            end_mark = f"_decoration_end_{number}"
            self.editor.mark_set(start_mark, f"1.0 + {start}c")
            self.editor.mark_gravity(start_mark, "right")
            self.editor.mark_set(end_mark, f"1.0 + {end}c")
            self.editor.mark_gravity(end_mark, "left")
            self._decoration_records.append(
                _DecorationRecord(
                    start,
                    end,
                    decoration_type,
                    decoration,
                    start_mark,
                    end_mark,
                )
            )

        for record in sorted(self._decoration_records, key=lambda item: item.start, reverse=True):
            if self._should_mount_decoration(
                record,
                insert_offset,
                active_line_start,
                active_line_end,
            ):
                self._mount_decoration(record)

    def _collect_block_decorations(self) -> list[tuple[int, int, str, object]]:
        decorations: list[tuple[int, int, str, object]] = []
        for rule in self._analysis.horizontal_rules:
            decorations.append((rule.start, rule.end, "rule", rule))
        for table in self._analysis.tables:
            decorations.append((table.start, table.end, "table", table))
        for marker in self._analysis.list_markers:
            decorations.append((marker.start, marker.end, "list_marker", marker))
        for expression in self._analysis.math_expressions:
            if any(table.start <= expression.start and expression.end <= table.end for table in self._analysis.tables):
                continue
            decorations.append((expression.start, expression.end, "math", expression))
        return decorations

    @staticmethod
    def _should_mount_decoration(
        record: _DecorationRecord,
        insert_offset: int,
        active_line_start: int,
        active_line_end: int,
    ) -> bool:
        if record.decoration_type == "rule":
            return not record.start <= insert_offset <= record.end
        if record.decoration_type == "table":
            return not record.start <= insert_offset < record.end
        return record.end <= active_line_start or record.start >= active_line_end

    def _create_decoration_widget(self, record: _DecorationRecord) -> tk.Widget:
        if record.decoration_type == "rule":
            return self._create_horizontal_rule_widget()
        if record.decoration_type == "table":
            return self._create_table_widget(record.decoration)  # type: ignore[arg-type]
        if record.decoration_type == "list_marker":
            return self._create_list_marker_widget(record.decoration)  # type: ignore[arg-type]
        return self._create_math_widget(record.decoration)  # type: ignore[arg-type]

    def _mount_decoration(self, record: _DecorationRecord) -> None:
        if record.widget is not None:
            return
        widget = self._create_decoration_widget(record)
        self.editor.window_create(record.start_mark, window=widget, align="center")
        self._bind_editor_decoration_events(widget)
        self.editor.tag_add("marker_hidden", record.start_mark, record.end_mark)
        record.widget = widget
        self._decoration_widgets.append(widget)

    def _unmount_decoration(self, record: _DecorationRecord) -> None:
        widget = record.widget
        if widget is None:
            return
        try:
            window_index = self.editor.index(str(widget))
            self.editor.delete(window_index)
        except tk.TclError:
            pass
        try:
            widget.destroy()
        except tk.TclError:
            pass
        try:
            self._decoration_widgets.remove(widget)
        except ValueError:
            pass
        record.widget = None
        self.editor.tag_remove("marker_hidden", record.start_mark, record.end_mark)
        self._set_marker_visibility(record.start_mark, record.end_mark, hidden=True)

    def _sync_block_decorations(
        self,
        insert_offset: int,
        active_line_start: int,
        active_line_end: int,
    ) -> None:
        if not self.hide_markers.get():
            return
        records_to_unmount: list[_DecorationRecord] = []
        records_to_mount: list[_DecorationRecord] = []
        for record in self._decoration_records:
            should_mount = self._should_mount_decoration(
                record,
                insert_offset,
                active_line_start,
                active_line_end,
            )
            if record.widget is not None and not should_mount:
                records_to_unmount.append(record)
            elif record.widget is None and should_mount:
                records_to_mount.append(record)

        for record in sorted(records_to_unmount, key=lambda item: item.start, reverse=True):
            self._unmount_decoration(record)
        for record in sorted(records_to_mount, key=lambda item: item.start, reverse=True):
            self._mount_decoration(record)

    def _decoration_width(self) -> int:
        return max(280, self.editor.winfo_width() - 70)

    def _create_horizontal_rule_widget(self) -> tk.Frame:
        container = tk.Frame(
            self.editor,
            background="#ffffff",
            borderwidth=0,
            height=18,
            width=self._decoration_width(),
        )
        container.pack_propagate(False)
        line = tk.Frame(container, background="#d1d5db", borderwidth=0, height=1)
        line.pack(fill="x", pady=8)
        return container

    def _create_list_marker_widget(self, marker: ListMarker) -> tk.Label:
        if marker.ordered:
            font_size = LIST_NUMBER_FONT_SIZE
        elif marker.label == "○":
            font_size = LIST_HOLLOW_BULLET_FONT_SIZE
        else:
            font_size = LIST_BULLET_FONT_SIZE
        return tk.Label(
            self.editor,
            text=marker.label,
            background="#ffffff",
            foreground="#111827",
            borderwidth=0,
            font=(self._latin_font_family, font_size, "bold"),
            padx=1,
            pady=0,
        )

    def _create_math_widget(
        self,
        expression: MathExpression,
        parent: tk.Misc | None = None,
        *,
        inline_font_size: int | None = None,
    ) -> tk.Widget:
        widget_parent = parent or self.editor
        source_expression = expression.expression.strip()
        if expression.display:
            font_size = DISPLAY_MATH_FONT_SIZE
        elif inline_font_size is not None:
            font_size = inline_font_size
        elif expression.heading_level is not None:
            font_size = HEADING_FONT_SIZES[expression.heading_level - 1]
        else:
            font_size = INLINE_MATH_FONT_SIZE
        try:
            from PIL import Image, ImageTk

            render_dpi = DISPLAY_MATH_DPI if expression.display else INLINE_MATH_RENDER_DPI
            image_bytes = render_math_png(
                source_expression,
                font_size,
                render_dpi,
                vertical_padding_points=(
                    DISPLAY_MATH_VERTICAL_PADDING_POINTS if expression.display else 0.0
                ),
                allow_structured=expression.display,
            )
            rendered_image = Image.open(BytesIO(image_bytes)).convert("RGBA")
            if not expression.display:
                display_scale = INLINE_MATH_DISPLAY_DPI / INLINE_MATH_RENDER_DPI
                display_size = (
                    max(1, round(rendered_image.width * display_scale)),
                    max(1, round(rendered_image.height * display_scale)),
                )
                rendered_image = rendered_image.resize(display_size, Image.Resampling.LANCZOS)
                vertically_centered_image = Image.new(
                    "RGBA",
                    (rendered_image.width, rendered_image.height + INLINE_MATH_TOP_PADDING),
                    (255, 255, 255, 0),
                )
                vertically_centered_image.alpha_composite(
                    rendered_image,
                    (0, INLINE_MATH_TOP_PADDING),
                )
                rendered_image = vertically_centered_image
            photo = ImageTk.PhotoImage(rendered_image)
            if not expression.display:
                image_label = tk.Label(widget_parent, image=photo, background="#ffffff", borderwidth=0)
                image_label.image = photo  # type: ignore[attr-defined]
                return image_label

            container = tk.Frame(
                widget_parent,
                background="#ffffff",
                borderwidth=0,
                width=self._decoration_width(),
                height=rendered_image.height + 16,
            )
            container.pack_propagate(False)
            image_label = tk.Label(container, image=photo, background="#ffffff", borderwidth=0)
            image_label.image = photo  # type: ignore[attr-defined]
            image_label.pack(expand=True)
            return container
        except Exception:
            return tk.Label(
                widget_parent,
                text=f"$${source_expression}$$" if expression.display else f"${source_expression}$",
                background="#ffffff",
                foreground="#4338ca",
                borderwidth=0,
                font=(
                    MATH_SOURCE_FONT_FAMILY,
                    font_size,
                ),
                padx=4,
            )

    def _create_table_cell_widget(
        self,
        parent: tk.Misc,
        value: str,
        row_index: int,
        alignment: str,
        cell_width: int,
        cell_analysis: MarkdownAnalysis | None = None,
    ) -> tk.Widget:
        cell_analysis = cell_analysis or analyze_markdown(value)
        math_expressions = [expression for expression in cell_analysis.math_expressions if not expression.display]
        anchor = {"left": "w", "center": "center", "right": "e"}[alignment]
        weight = "bold" if row_index == 0 else "normal"
        if not math_expressions:
            cell_font_family = (
                self._japanese_font_family
                if any(is_japanese_character(character) for character in value)
                else self._latin_font_family
            )
            return tk.Label(
                parent,
                text=value,
                anchor=anchor,
                background="#ffffff",
                foreground="#20242b",
                font=(cell_font_family, 10, weight),
                padx=10,
                pady=6,
                wraplength=cell_width,
            )

        cell = tk.Frame(parent, background="#ffffff", borderwidth=0, padx=10, pady=6)
        content = tk.Frame(cell, background="#ffffff", borderwidth=0)
        content.pack(anchor=anchor)
        current_offset = 0
        for expression in math_expressions:
            text_segment = value[current_offset : expression.start]
            if text_segment:
                segment_font_family = (
                    self._japanese_font_family
                    if any(is_japanese_character(character) for character in text_segment)
                    else self._latin_font_family
                )
                tk.Label(
                    content,
                    text=text_segment,
                    background="#ffffff",
                    foreground="#20242b",
                    font=(segment_font_family, 10, weight),
                    borderwidth=0,
                ).pack(side="left")
            math_widget = self._create_math_widget(
                expression,
                parent=content,
                inline_font_size=10,
            )
            math_widget.pack(side="left")
            current_offset = expression.end

        trailing_text = value[current_offset:]
        if trailing_text:
            trailing_font_family = (
                self._japanese_font_family
                if any(is_japanese_character(character) for character in trailing_text)
                else self._latin_font_family
            )
            tk.Label(
                content,
                text=trailing_text,
                background="#ffffff",
                foreground="#20242b",
                font=(trailing_font_family, 10, weight),
                borderwidth=0,
            ).pack(side="left")
        return cell

    def _create_table_widget(self, table: TableBlock) -> tk.Frame:
        column_count = len(table.alignments)
        available_width = self._decoration_width()
        cell_width = max(80, available_width // max(1, column_count) - 20)
        cell_analyses = [
            [analyze_markdown(value) for value in row]
            for row in table.rows
        ]
        row_heights = [
            44
            if any(
                any(not expression.display for expression in analysis.math_expressions)
                for analysis in analysis_row
            )
            else 34
            for analysis_row in cell_analyses
        ]
        separator_widths = [
            TABLE_STRONG_LINE_WIDTH if row_index in {0, len(table.rows) - 1} else TABLE_LINE_WIDTH
            for row_index in range(len(table.rows))
        ]
        table_height = sum(row_heights) + TABLE_STRONG_LINE_WIDTH + sum(separator_widths)
        container = tk.Frame(
            self.editor,
            background="#ffffff",
            borderwidth=0,
            width=available_width,
            height=table_height,
        )
        container.grid_propagate(False)
        for column in range(column_count):
            container.grid_columnconfigure(column, weight=1, uniform="markdown_table")

        container.grid_rowconfigure(0, minsize=TABLE_STRONG_LINE_WIDTH)
        top_border = tk.Frame(
            container,
            background=TABLE_LINE_COLOR,
            borderwidth=0,
            height=TABLE_STRONG_LINE_WIDTH,
        )
        top_border.grid(row=0, column=0, columnspan=column_count, sticky="ew")

        for row_index, row in enumerate(table.rows):
            grid_row = row_index * 2 + 1
            container.grid_rowconfigure(grid_row, minsize=row_heights[row_index])
            for column, value in enumerate(row):
                alignment = table.alignments[column]
                cell_widget = self._create_table_cell_widget(
                    container,
                    value,
                    row_index,
                    alignment,
                    cell_width,
                    cell_analyses[row_index][column],
                )
                cell_widget.grid(row=grid_row, column=column, sticky="ew")
            separator_width = separator_widths[row_index]
            container.grid_rowconfigure(grid_row + 1, minsize=separator_width)
            separator = tk.Frame(
                container,
                background=TABLE_LINE_COLOR,
                borderwidth=0,
                height=separator_width,
            )
            separator.grid(row=grid_row + 1, column=0, columnspan=column_count, sticky="ew")

        return container

    def _bind_editor_decoration_events(
        self,
        widget: tk.Widget,
        decoration_widget: tk.Widget | None = None,
    ) -> None:
        decoration_widget = decoration_widget or widget
        widget.bind("<MouseWheel>", self._forward_editor_mousewheel, add="+")
        widget.bind(
            "<Button-1>",
            lambda _event, target=decoration_widget: self._activate_decoration_line(target),
            add="+",
        )
        for child in widget.winfo_children():
            self._bind_editor_decoration_events(child, decoration_widget)

    def _activate_decoration_line(self, widget: tk.Widget) -> str:
        try:
            window_index = self.editor.index(str(widget))
        except tk.TclError:
            return "break"
        self.editor.mark_set("insert", f"{window_index} + 1c")
        self.editor.focus_set()
        self._on_cursor_moved()
        return "break"

    def _forward_editor_mousewheel(self, event: tk.Event) -> str | None:
        delta = int(getattr(event, "delta", 0))
        if delta == 0:
            return None
        direction = -1 if delta > 0 else 1
        scroll_pixels = max(
            1,
            round(abs(delta) / WINDOWS_MOUSE_WHEEL_DELTA * EDITOR_SCROLL_PIXELS_PER_NOTCH),
        )
        first, last = self.editor.yview()
        visible_fraction = max(0.0, last - first)
        viewport_height = max(1, self.editor.winfo_height())
        fraction_delta = direction * scroll_pixels * visible_fraction / viewport_height
        maximum_first = max(0.0, 1.0 - visible_fraction)
        self.editor.yview_moveto(min(max(first + fraction_delta, 0.0), maximum_first))
        return "break"

    def _on_editor_yview_changed(self, first: str, last: str) -> None:
        self._editor_scrollbar.set(first, last)
        if self._scroll_redraw_job is None:
            self._scroll_redraw_job = self.root.after_idle(self._flush_editor_scroll_redraw)

    def _flush_editor_scroll_redraw(self) -> None:
        try:
            self.editor.update_idletasks()
        finally:
            self._scroll_redraw_job = None

    def _highlight_current_line(self) -> None:
        self.editor.tag_remove("current_line", "1.0", "end")
        self.editor.tag_add("current_line", "insert linestart", "insert lineend +1c")
        self.editor.tag_lower("current_line")

    def _selection_indices(self) -> tuple[str, str] | None:
        try:
            return self.editor.index("sel.first"), self.editor.index("sel.last")
        except tk.TclError:
            return None

    def _confirm_discard(self) -> bool:
        if not self.dirty:
            return True
        choice = messagebox.askyesnocancel(
            APP_NAME,
            "変更内容を保存しますか？",
            parent=self.root,
        )
        if choice is None:
            return False
        if choice:
            return self.save() is not None
        return True

    def new_document(self, event: tk.Event | None = None, *, confirm: bool = True) -> str:
        if confirm and not self._confirm_discard():
            return self._break()
        self.current_path = None
        self._replace_text("")
        return self._break()

    def open_document(self, _event: tk.Event | None = None) -> str:
        if not self._confirm_discard():
            return self._break()
        selected = filedialog.askopenfilename(
            parent=self.root,
            title="Markdownファイルを開く",
            filetypes=(("Markdown", "*.md"), ("すべてのファイル", "*.*")),
        )
        if selected:
            self.open_path(Path(selected), confirm=False)
        return self._break()

    def open_path(self, path: Path, *, confirm: bool = True) -> bool:
        if confirm and not self._confirm_discard():
            return False
        try:
            content = read_markdown(path)
        except (OSError, UnicodeError) as error:
            messagebox.showerror(APP_NAME, f"ファイルを開けませんでした。\n\n{error}", parent=self.root)
            return False
        self.current_path = path.resolve()
        self._replace_text(content)
        return True

    def _replace_text(self, content: str) -> None:
        self._clear_decorations()
        self.editor.delete("1.0", "end")
        self.editor.insert("1.0", content)
        self.editor.mark_set("insert", "1.0")
        self.editor.edit_reset()
        self.editor.edit_modified(False)
        self.dirty = False
        self.render_markdown()

    def save(self, _event: tk.Event | None = None) -> Path | None:
        if self.current_path is None:
            return self.save_as()
        return self._save_to(self.current_path)

    def save_as(self, _event: tk.Event | None = None) -> Path | None:
        initial_name = self.current_path.name if self.current_path else "memo.md"
        selected = filedialog.asksaveasfilename(
            parent=self.root,
            title="名前を付けて保存",
            defaultextension=".md",
            initialfile=initial_name,
            filetypes=(("Markdown", "*.md"),),
        )
        if not selected:
            return None
        return self._save_to(Path(selected))

    def _save_to(self, path: Path) -> Path | None:
        content = self.editor.get("1.0", "end-1c")
        try:
            saved_path = write_markdown(path, content)
        except OSError as error:
            messagebox.showerror(APP_NAME, f"保存できませんでした。\n\n{error}", parent=self.root)
            return None
        self.current_path = saved_path.resolve()
        self.dirty = False
        self.editor.edit_modified(False)
        self._update_title_and_status(message="保存しました")
        return self.current_path

    def export_pdf(self, _event: tk.Event | None = None) -> str:
        if self.current_path is None or self.dirty:
            markdown_path = self.save()
            if markdown_path is None:
                return self._break()
        else:
            markdown_path = self.current_path

        pdf_path = markdown_path.with_suffix(".pdf")
        if pdf_path.exists() and not messagebox.askyesno(
            APP_NAME,
            f"{pdf_path.name} は既に存在します。上書きしますか？",
            parent=self.root,
        ):
            return self._break()

        markdown_text = self.editor.get("1.0", "end-1c")
        self._update_title_and_status(message="PDFを書き出しています...")
        self.root.update_idletasks()
        try:
            from .pdf_exporter import export_markdown_to_pdf

            exported_path = export_markdown_to_pdf(markdown_text, markdown_path, pdf_path)
        except Exception as error:
            messagebox.showerror(
                APP_NAME,
                f"PDFを書き出せませんでした。\n\n{error}",
                parent=self.root,
            )
            self._update_title_and_status(message="PDFの書き出しに失敗しました")
            return self._break()

        self._update_title_and_status(message=f"PDFを書き出しました: {exported_path.name}")
        return self._break()

    def close(self, _event: tk.Event | None = None) -> str:
        if self._confirm_discard():
            self._cancel_scheduled_jobs()
            self.root.destroy()
        return self._break()

    def _cancel_scheduled_jobs(self) -> None:
        for attribute in (
            "_render_job",
            "_scroll_redraw_job",
            "_resize_job",
            "_math_preload_job",
            "_script_font_tag_job",
        ):
            job = getattr(self, attribute)
            if job is None:
                continue
            try:
                self.root.after_cancel(job)
            except tk.TclError:
                pass
            setattr(self, attribute, None)

    def wrap_selection(self, marker: str) -> str:
        selection = self._selection_indices()
        if selection:
            start, end = selection
            selected_text = self.editor.get(start, end)
            self.editor.delete(start, end)
            self.editor.insert(start, f"{marker}{selected_text}{marker}")
            self.editor.tag_add("sel", f"{start} + {len(marker)}c", f"{end} + {len(marker)}c")
        else:
            index = self.editor.index("insert")
            self.editor.insert(index, marker + marker)
            self.editor.mark_set("insert", f"{index} + {len(marker)}c")
        return self._break()

    def show_table_dialog(self, _event: tk.Event | None = None) -> str:
        selection = self._selection_indices()
        insertion_target: tuple[str, str] | str = selection if selection else self.editor.index("insert")
        dialog = tk.Toplevel(self.root)
        dialog.title("表を挿入")
        dialog.resizable(False, False)
        dialog.transient(self.root)

        content = ttk.Frame(dialog, padding=16)
        content.grid(row=0, column=0, sticky="nsew")

        ttk.Label(content, text="行").grid(row=0, column=0, padx=(0, 6), pady=(0, 12))
        row_value = tk.StringVar(value="2")
        row_entry = ttk.Entry(content, textvariable=row_value, width=8, justify="center")
        row_entry.grid(row=0, column=1, padx=(0, 18), pady=(0, 12))

        ttk.Label(content, text="列").grid(row=0, column=2, padx=(0, 6), pady=(0, 12))
        column_value = tk.StringVar(value="2")
        column_entry = ttk.Entry(content, textvariable=column_value, width=8, justify="center")
        column_entry.grid(row=0, column=3, pady=(0, 12))

        buttons = ttk.Frame(content)
        buttons.grid(row=1, column=0, columnspan=4)

        def insert_table() -> None:
            try:
                row_count = int(row_value.get())
                column_count = int(column_value.get())
            except ValueError:
                messagebox.showwarning(
                    APP_NAME,
                    f"行数と列数は1から{MAX_TABLE_DIMENSION}までの整数で指定してください。",
                    parent=dialog,
                )
                return
            try:
                build_table_template(row_count, column_count)
            except ValueError as error:
                messagebox.showwarning(APP_NAME, str(error), parent=dialog)
                return
            dialog.destroy()
            self._insert_table(row_count, column_count, insertion_target)

        ttk.Button(buttons, text="挿入", command=insert_table).grid(row=0, column=0, padx=(0, 6))
        ttk.Button(buttons, text="キャンセル", command=dialog.destroy).grid(row=0, column=1)

        dialog.bind("<Return>", lambda _event: insert_table())
        dialog.bind("<Escape>", lambda _event: dialog.destroy())
        dialog.protocol("WM_DELETE_WINDOW", dialog.destroy)
        self._center_dialog(dialog)
        dialog.grab_set()
        row_entry.focus_set()
        row_entry.selection_range(0, "end")
        return self._break()

    def _center_dialog(self, dialog: tk.Toplevel) -> None:
        dialog.update_idletasks()
        horizontal_position = self.root.winfo_rootx() + (self.root.winfo_width() - dialog.winfo_reqwidth()) // 2
        vertical_position = self.root.winfo_rooty() + (self.root.winfo_height() - dialog.winfo_reqheight()) // 2
        dialog.geometry(f"+{max(0, horizontal_position)}+{max(0, vertical_position)}")

    def _insert_table(
        self,
        row_count: int,
        column_count: int,
        target: tuple[str, str] | str | None = None,
    ) -> None:
        table = build_table_template(row_count, column_count)
        selection = target if isinstance(target, tuple) else self._selection_indices()
        if selection is not None:
            insertion_index, selection_end = selection
            self.editor.delete(insertion_index, selection_end)
        else:
            insertion_index = target if isinstance(target, str) else self.editor.index("insert")

        insertion_index = self.editor.index(insertion_index)
        needs_leading_newline = self.editor.compare(insertion_index, "!=", f"{insertion_index} linestart")
        needs_trailing_newline = self.editor.compare(insertion_index, "!=", f"{insertion_index} lineend")
        insertion_text = f"{'\n' if needs_leading_newline else ''}{table}{'\n' if needs_trailing_newline else ''}"
        self.editor.insert(insertion_index, insertion_text)
        self.editor.mark_set("insert", f"{insertion_index} + {len(insertion_text)}c")
        self.editor.see("insert")
        self.editor.edit_separator()
        self.dirty = True
        self._analysis_stale = True
        self._document_statistics_dirty = True
        self._schedule_render()
        self._update_title_and_status()
        self.editor.focus_set()

    def show_search(self, _event: tk.Event | None = None) -> str:
        search_frame, search_entry = self._ensure_search_widgets()
        if not self._search_visible:
            search_frame.grid(row=2, column=0, columnspan=2, sticky="ew")
            self._search_visible = True
        selected = self._selection_indices()
        if selected:
            search_entry.delete(0, "end")
            search_entry.insert(0, self.editor.get(*selected))
        search_entry.focus_set()
        search_entry.selection_range(0, "end")
        self.highlight_search_matches()
        return self._break()

    def hide_search(self) -> str:
        if self.search_frame is not None:
            self.search_frame.grid_remove()
        self.editor.tag_remove("search_match", "1.0", "end")
        self.editor.tag_remove("search_current", "1.0", "end")
        self._search_visible = False
        self.editor.focus_set()
        return self._break()

    def highlight_search_matches(self) -> None:
        self.editor.tag_remove("search_match", "1.0", "end")
        self.editor.tag_remove("search_current", "1.0", "end")
        if self.search_entry is None:
            return
        query = self.search_entry.get()
        if not query:
            return
        start = "1.0"
        while True:
            match = self.editor.search(query, start, stopindex="end", nocase=True, elide=True)
            if not match:
                break
            end = f"{match} + {len(query)}c"
            self.editor.tag_add("search_match", match, end)
            start = end

    def find_next(self, event: tk.Event | None = None, *, backwards: bool = False) -> str:
        if self.search_entry is None:
            return self._break()
        query = self.search_entry.get()
        if not query:
            return self._break()
        start = self.editor.index("insert")
        options = {"pattern": query, "nocase": True, "backwards": backwards, "elide": True}
        if backwards:
            match = self.editor.search(stopindex="1.0", index=start, **options)
            if not match:
                match = self.editor.search(stopindex="1.0", index="end", **options)
        else:
            match = self.editor.search(stopindex="end", index=f"{start} +1c", **options)
            if not match:
                match = self.editor.search(stopindex="end", index="1.0", **options)
        if match:
            end = f"{match} + {len(query)}c"
            self.editor.tag_remove("search_current", "1.0", "end")
            self.editor.tag_add("search_current", match, end)
            self.editor.mark_set("insert", match)
            self.editor.see(match)
        return self._break()

    def _on_control_click(self, event: tk.Event) -> str | None:
        index = self.editor.index(f"@{event.x},{event.y}")
        offset = len(self.editor.get("1.0", index))
        for reference in self._analysis.links:
            if reference.start <= offset <= reference.end:
                self._open_reference(reference)
                return self._break()
        return None

    def _open_reference(self, reference: LinkReference) -> None:
        target = reference.target.strip("<>")
        if reference.is_image:
            self._show_image_preview(target)
            return
        if target.startswith(("http://", "https://", "mailto:")):
            webbrowser.open(target)
        else:
            path = self._resolve_local_path(target)
            if path.exists():
                os.startfile(path)  # type: ignore[attr-defined]

    def _resolve_local_path(self, target: str) -> Path:
        path = Path(target)
        if path.is_absolute():
            return path
        base = self.current_path.parent if self.current_path else Path.cwd()
        return (base / path).resolve()

    def _show_image_preview(self, target: str) -> None:
        path = self._resolve_local_path(target)
        if not path.exists():
            messagebox.showwarning(APP_NAME, f"画像が見つかりません。\n\n{path}", parent=self.root)
            return
        try:
            from PIL import Image, ImageTk

            image = Image.open(path)
            image.thumbnail((720, 520))
            photo = ImageTk.PhotoImage(image)
        except (ImportError, OSError) as error:
            messagebox.showerror(APP_NAME, f"画像を表示できませんでした。\n\n{error}", parent=self.root)
            return
        preview = tk.Toplevel(self.root)
        preview.title(path.name)
        label = ttk.Label(preview, image=photo, padding=8)
        label.image = photo  # type: ignore[attr-defined]
        label.pack(fill="both", expand=True)
        preview.transient(self.root)

    def _update_title_and_status(self, *, message: str | None = None) -> None:
        name = self.current_path.name if self.current_path else "無題.md"
        marker = " *" if self.dirty else ""
        self.root.title(f"{name}{marker} — {APP_NAME}")
        if self._document_statistics_dirty:
            self._set_document_statistics(self.editor.get("1.0", "end-1c"))
        line, column = self.editor.index("insert").split(".")
        state = "未保存" if self.dirty else "保存済み"
        if self.current_path is None and not self.dirty:
            state = "新規"
        parts = [
            name,
            state,
            f"{self._character_count}文字",
            f"{self._word_count}語",
            f"行 {line}, 列 {int(column) + 1}",
        ]
        if message:
            parts.append(message)
        self.status_text.set("  |  ".join(parts))

    def _set_document_statistics(self, text: str) -> None:
        self._character_count = len(text)
        self._word_count = len(text.split())
        self._document_statistics_dirty = False
