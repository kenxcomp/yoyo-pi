# Agent Notes

## Pi extension local repo vs installed package cache

今天遇到的问题：在仓库 `/Users/kennethx/Repo/yoyo-pi` 中新增了 `/theme-bg`，但当前正在运行的 pi 没有识别该命令，用户输入 `/theme-bg true` 被当成普通消息发送给 agent。

原因：当前 pi 实际加载的是已安装的 git package 缓存：

```text
~/.pi/agent/git/github.com/kenxcomp/yoyo-pi
```

而不是工作区仓库：

```text
/Users/kennethx/Repo/yoyo-pi
```

所以只修改工作区仓库后，`/reload` 不一定能看到新命令；需要让运行中的 pi 加载到同一份代码。

处理方式：

1. 开发时确认 pi 实际加载路径。
2. 如当前 pi 加载的是安装缓存，需要同步缓存、重新安装/更新 package，或用本地路径启动测试。
3. 同步后在 pi TUI 中执行 `/reload`，再使用新命令。
4. 最终应 commit/push 仓库改动，避免后续 `pi update` 覆盖手动同步到缓存的改动。

本次临时处理：已把 `README.md` 和 `extensions/kenx-infra/index.ts` 同步到 `~/.pi/agent/git/github.com/kenxcomp/yoyo-pi`，然后需要在 pi 中执行 `/reload`。
