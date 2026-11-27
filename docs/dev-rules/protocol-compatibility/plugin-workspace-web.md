# 插件本机工作空间网页

`mainView.workspaceWeb` 是可选的 Desktop 本机界面声明，只接受带显式非默认端口的
`http://127.0.0.1` 源。包内主视图 HTML 仍需存在；旧宿主按包内页面工作。新声明只用于
显式启用的插件，安装权限展示绑定到精确源。提取路径、工作空间身份与启用状态都在 Host 校验。

Desktop 的本机 UI 请求调用已批准插件的 Node JSON-RPC 方法 `workspaceWeb.resolve`，
入参是当前账号本机会话的工作目录或 `null`，回包只含工作空间标识和同源路径。
该 IPC 未进入 Device Link 准入，移动端和 Node Host 无需实现。页面由顶层网页访客加载，
使用独立账户与插件分区，不向页面暴露桥接 API、Node、跨源网络或弹窗。隔离预加载仅捕获
顶层访客的真实新页签链接点击。主进程复验当前已批准的访客来源，只转交无 URL 凭证的 HTTP(S)
地址给现有右栏浏览器。脚本弹窗和模拟点击不会创建页签。

工作空间归属仅用于本次打开的初始路由和选择网页实例。用户在页面内导航到其他空间时，
会话切换保留网页实例和导航状态。参考[插件作者手册](../../../apps/desktop/resources/system-skills/cindy-plugin-creator/references/plugin-main-view.md)。
