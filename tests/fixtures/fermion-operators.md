# フェルミ粒子の生成・消滅演算子

## フェルミ粒子を付け足す操作

> 状態$\ket{\Phi}$を構成する各々の直積に対して、可能な場所に$\ket{j}$を挿入した直積を作る。挿入位置が左から初期値を1として
> 奇数番目は$+$倍、偶数番目は$-$倍する。その後規格化として全体を$\sqrt{N+1}$で割ったものが$\hat{a_j}{^\dagger}\ket{\Phi}$である。($N$は$\ket{\Phi}$の粒子数)

ボース粒子を付け足す操作に加えて反対称性を考慮した操作になっている。
フェルミ粒子系の状態ベクトルに粒子を付け足す操作は順序に依存し、
$$
\hat{a_j}^{\dagger}\hat{a_k}^{\dagger}=-\hat{a_k}^{\dagger}\hat{a_j}^{\dagger}
$$
となり、$j=k$とすると、
$$
\hat{a_j}^{\dagger}\hat{a_j}^{\dagger}=-\hat{a_l}^{\dagger}\hat{a_j}^{\dagger},\qquad \therefore \hat{a_j}^{\dagger}\hat{a_j}^{\dagger}=0
$$
となり、パ入りの排他原理が導かれる。

フェルミ粒子系において、各状態の粒子数$n_j$は0または1のみであるため、数表示の任意な状態ベクトルを作るには、
$$
\begin{align*}
\ket{n_1,n_2,\cdots,n_M}&=(\hat{a_1}^{\dagger})^{n_1}\cdots(\hat{a_M}^{\dagger})^{n_M}\ket{0}\\
&=\prod_{j=1}^{M}(\hat{a_j}^{\dagger})^{n_j}\ket{0}
\end{align*}
$$
とすればよい。各々の状態の粒子数は0または1なので、重複項は存在しないため、階乗の根号で割る必要はない。(それか$0!,1!$はどちらも1なので$\sqrt{1}$で割っている)

このとき、添え字の番号が小さい順に演算子を左から並べることを約束すると状態ベクトルの符号を一意に定めることができる。

この定義のもと、$\ket{j}$を含まない状態ベクトルに$\hat{a_j}^\dagger$を作用させるとき、先頭に$\hat{a_j}^\dagger$が来るため先ほどの約束を満たすことができない。そのため、約束通りにするため順番をひとつずつ交代していく。必要な交換回数$s$は、
$$
s=n_1+n_2+\cdots+n_{j-1}
$$
である。この$s$を用いると、
$$
\hat{a_j}^\dagger\ket{\cdots,0,\cdots}=(-1)^s\ket{\cdots,1,\cdots}
$$

と書ける。

## フェルミ粒子を取り除く操作

先ほどの式のエルミート共役は、
$$
\bra{\cdots,0,\cdots}\hat{a_j}=(-1)^s\bra{\cdots,1,\cdots}
$$
である。ここで、$j$番目を含めた完全性関係は、
$$
\hat I
=
\sum_{\{n_i\}_{i\neq j}}
\left(
|\cdots,0,\cdots\rangle\langle\cdots,0,\cdots|
+
|\cdots,1,\cdots\rangle\langle\cdots,1,\cdots|
\right).
$$
