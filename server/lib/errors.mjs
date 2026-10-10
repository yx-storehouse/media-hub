/*
 * 用户输入类错误：路由层收到它就返回 400（或 e.status），并把 message 原样展示给用户。
 * 其余异常（SQL 出错、代码 bug）一律 500 —— 不再靠关键词去猜。
 * field（可选）：出错的接口字段名（camelCase），管理后台据此把提示标到对应输入框下。
 *
 * 单独成文件：admin/fields.mjs 这类纯函数模块只依赖它，import 时不会顺带打开数据库。
 * server/api.mjs 原样再导出，api.InputError 仍是同一个类。
 */
export class InputError extends Error {
  constructor(message, field) {
    super(message)
    if (field) this.field = field
  }
}
