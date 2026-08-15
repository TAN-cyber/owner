/**
 * 引用单个参数，使其在 `shell: true` 调用时被 shell 当作一个完整参数。
 *
 * 背景：Node.js 在 `shell: true` 时会把参数数组用空格拼成一条命令行字符串，
 * 但**不会**自动给含空格/特殊字符的参数加引号。这会导致形如
 * `C:\Users\Test User\project` 的路径被 cmd 拆成两个参数，使依赖路径参数的
 * 命令（如 `openspec init <path>`）报 "too many arguments"（见 issue #123）。
 *
 * 解决：在 `shell: true` 的调用前，对每个参数手动引用。本函数按 cmd.exe
 * 约定用双引号包裹，并把内部的双引号转义为 `""`。
 *
 * 仅对打算走 `shell: true` 的命令使用；非 Windows 上 shell 通常为 false，
 * 不应调用本函数（参数会被 Node 直接经 argv 传递，无需引用）。
 */
function quoteForShell(arg: string): string {
  // 已经安全（无空格、无引号、无 cmd 元字符等）的参数原样返回，
  // 保持错误信息与日志可读（如 '--tools'、'init'、'C:\Projects\Owner'）。
  // 注意：不包含 `%`（cmd 变量展开符）和 `& | < > ^ ( )` 等 cmd 元字符，
  // 也不包含空格——含这些字符的参数一律引用。
  if (arg.length > 0 && /^[A-Za-z0-9@+=:,./\\_-]+$/.test(arg)) {
    return arg;
  }
  // cmd.exe 约定：双引号包裹，内部双引号转义为 ""。
  return `"${arg.replace(/"/g, '""')}"`;
}

/**
 * 对一组参数逐个引用，返回新数组（不改原数组）。
 * 用于 `shell: true` 调用前的整体参数处理。
 */
function quoteArgsForShell(args: string[]): string[] {
  return args.map((arg) => quoteForShell(arg));
}

export { quoteForShell, quoteArgsForShell };
