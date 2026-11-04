/** Localized HTML for the server-owned account pages; no client script or persistent browser storage. @module */
const en = {
  language: 'en', login: 'Account sign in', token: 'Entry token', enter: 'Sign in',
  failed: 'Sign in failed. Check your token and try again.', invalid: 'Invalid request.', refused: 'Request refused.',
  limited: 'Too many sign in attempts. Try again later.',
  capacity: 'Too many active sessions. Try again later.', access: 'Agent access', accountId: 'Account ID',
  grant: 'Grant access', revoke: 'Revoke access', confirm: 'Confirm revocation', cancel: 'Cancel',
  missing: 'Grant not found.', refresh: 'Refresh', app: 'Open application', logout: 'Sign out',
  scope: 'Accounts listed below can contact your agents. This is one-way access; conversations, memories and tables stay private.',
}
const pt: typeof en = {
  language: 'pt-BR', login: 'Entrar na conta', token: 'Token de entrada', enter: 'Entrar',
  failed: 'Não foi possível entrar. Confira o token e tente novamente.', invalid: 'Pedido inválido.', refused: 'Pedido recusado.',
  limited: 'Há muitas tentativas de entrada. Tente novamente mais tarde.',
  capacity: 'Há muitas sessões ativas. Tente novamente mais tarde.', access: 'Acesso aos agentes', accountId: 'ID da conta',
  grant: 'Conceder acesso', revoke: 'Revogar acesso', confirm: 'Confirmar revogação', cancel: 'Cancelar',
  missing: 'Concessão não encontrada.', refresh: 'Atualizar', app: 'Abrir aplicativo', logout: 'Sair',
  scope: 'As contas abaixo podem contatar seus agentes. O acesso é de mão única; conversas, memórias e tabelas continuam privadas.',
}
/** Choose Portuguese for a Portuguese browser preference; other languages use English.
 * @param language - Accept-Language request header, if present.
 * @returns copy used by the whole page.
 */
export function copyFor(language: string | undefined): typeof en { return /^pt\b/i.test(language ?? '') ? pt : en }
/** Escape untrusted text and attribute values before inserting them in HTML.
 * @param value - account name or id.
 * @returns text without executable HTML delimiters.
 */
export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}
/** Wrap already escaped page content in the account navigation.
 * @param copy - selected localized copy.
 * @param body - escaped markup assembled by the route.
 * @param authenticated - whether a valid account session owns the page.
 * @returns a complete script-free HTML document.
 */
export function page(copy: typeof en, body: string, authenticated: boolean): string {
  return `<!doctype html><html lang="${copy.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${authenticated ? copy.access : copy.login}</title></head><body>${authenticated ? `<nav><a href="/">${copy.app}</a> · <a href="/account/access">${copy.access}</a><form method="post" action="/account/logout"><button>${copy.logout}</button></form></nav>` : ''}<main>${body}</main></body></html>`
}
