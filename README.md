# PopDict 词窗 - 划词翻译

一款简洁、轻量的网页划词翻译脚本。双击选中的文本，即可在当前页面快速查看翻译或词典释义。

![PopDict 演示](https://github.com/vlan20/popdict/blob/main/img/demo-1-cambridge-dict.gif)

## 功能介绍 / Features

PopDict 适合能够基本阅读英文内容，但偶尔需要查询生词或句子的用户。

无需离开当前网页，也不必复制文本到翻译网站。双击选中的内容，即可打开翻译窗口。

主要功能：

* 双击选中的文本即可翻译
* 支持有道词典、剑桥词典和谷歌翻译
* 支持英式和美式发音
* 支持切换默认翻译器
* 支持固定和拖动多个翻译窗口
* 支持亮色和深色模式
* 支持翻译结果缓存

## 安装方法 / Installation

目前主要在以下环境中使用和测试：

* 浏览器：Google Chrome
* 脚本管理器：Tampermonkey

### 1. 安装 Tampermonkey

通过 [Chrome 应用商店安装 Tampermonkey](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)。

### 2. 安装 PopDict

可以选择以下任意一种方式：

#### 方式一：通过 Greasy Fork 安装

打开 [PopDict 的 Greasy Fork 页面](https://greasyfork.org/en/scripts/528047)，点击安装脚本。

#### 方式二：通过 GitHub 安装

打开仓库中的 [`popdict.user.js`](https://github.com/vlan20/popdict/blob/main/popdict.user.js)，下载脚本文件。

下载完成后，将 `popdict.user.js` 拖入 Tampermonkey 的脚本管理页面，然后点击安装。

### 3. 开始使用

安装完成后刷新网页。

选中需要查询的文本并双击，即可打开翻译窗口。

## 版本发布 / Releases

各版本的更新内容和安装文件请查看 [GitHub Releases](https://github.com/vlan20/popdict/releases)。

## 问题反馈 / Feedback

使用过程中遇到问题，或者有功能需求和改进建议，可以前往 [Issues](https://github.com/vlan20/popdict/issues) 提交反馈。


感谢使用 PopDict。
