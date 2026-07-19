# 見出し1 Heading 1 $E=mc^2$

## 見出し2 Heading 2

### 見出し3 Heading 3

#### 見出し4 Heading 4

##### 見出し5 Heading 5

###### 見出し6 Heading 6

日本語と English、**太字 bold**、*斜体 italic*、***太字斜体 bold italic***、~~取り消し strike~~、`inline_code()`。

下線形式の __太字__、_斜体_、___太字斜体___。

[HTTPSリンク](https://example.com)、[メール](mailto:test@example.com)、[相対リンク](notes/next.md)。

エスケープ: \*装飾しない\*、\# 見出しにしない、\$数式にしない\$、\| 区切らない。

通常改行の1行目
通常改行の2行目  
明示改行の3行目

- ハイフンの親 $a^2+b^2=c^2$
   1. 番号の子
   1. 番号の子（連番）
     + プラスの孫
       1) 丸括弧番号のひ孫
   * アスタリスクの子へ復帰
     - ハイフンの孫
+ プラスの親へ復帰
* アスタリスクの親

1. 番号1
1. 番号2
1. 番号3
   - 番号内の箇条書き
     1. さらに番号
1. 番号4へ復帰

1) 丸括弧1
1) 丸括弧2

- [x] 完了項目
- [X] 大文字Xの完了項目
- [ ] 未完了項目

> 引用1行目 $\sqrt{2}$
> 引用2行目
> > 引用の深さ2
> > > 引用の深さ3

`$code内は数式にしない$` と [URL内のドル](https://example.com/$value)。

```python
def hello(name: str) -> None:
    print(f"こんにちは {name}")
```

~~~text
**コードブロック内は装飾しない**
$E=mc^2$
~~~

---

***

___

| 左寄せ | 中央 | 右寄せ |
| :--- | :---: | ---: |
| 日本語 | $\frac{a}{b}$ | 123 |
| $|x|$ | $A \cap C$ | **太字** |

![ローカル画像](sample.png)

文中画像: 前 ![小型画像](sample.png) 後。

![存在しない画像](missing.png)

![外部画像](https://example.com/image.png)

インライン端部: $AVfgjpqy$、$A \ni V \cap B \subseteq C$、$x_{ij}^{n+1}+y_k^2$。

インライン関数: $\int_{-\infty}^{\infty} e^{-x^2}\,dx$、$\sqrt[3]{x^2+y^2}$、$\hat{x}+\vec{v}+\overline{AB}+\ddot{q}$。

一般コマンド: $\tfrac{a}{b}+\dfrac{c}{d}+\operatorname{rank}(A)+\boldsymbol{\alpha}+\overset{!}{=}+\underset{x}{\lim}$。

$$\sum_{i=1}^{n}x_i+\prod_{k=1}^{m}y_k+\int_0^1 f(x)\,dx$$

$$\begin{matrix}a&b\\c&d\end{matrix}$$

$$\begin{pmatrix}a&b\\c&d\end{pmatrix}$$

$$\begin{bmatrix}a&b\\c&d\end{bmatrix}$$

$$\begin{Bmatrix}a&b\\c&d\end{Bmatrix}$$

$$\begin{vmatrix}a&b\\c&d\end{vmatrix}$$

$$\begin{Vmatrix}a&b\\c&d\end{Vmatrix}$$

$$f(x)=
\begin{cases}
x^2&x\geq 0\\
-x&x<0
\end{cases}+c$$

$$\begin{aligned}a&=b\\c&=d\end{aligned}$$

$$\begin{align*}p&=q\\r&=s\end{align*}$$

$$u&=v\\w&=z$$
