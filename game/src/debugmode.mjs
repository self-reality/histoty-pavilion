// Is this page running in debug mode?
//
// Debug mode is a URL, not a build flag — there is no build step here, and a
// second copy of index.html would drift from the first the week after it was
// made. So one page, one bootstrap, and the address decides:
//
//   /            production — no panel, no tweak sliders, debug.mjs never fetched
//   /?debug      the same game plus the tweak panel (see debug.mjs)
//   /debug.html  a redirect to /?debug, so the debug build has a typeable URL
//
// The Editor build reads the same flag; its launch URL already carries query
// params, so append `&debug` there.
export function isDebugMode() {
  return new URLSearchParams(location.search).has('debug');
}
