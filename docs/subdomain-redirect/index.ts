/**
 * The docs used to live at yieldstar.notation.dev. They are now served at
 * notation.dev/yieldstar, so every old URL redirects to the same path there.
 */
export default {
  fetch(request: Request): Response {
    const { pathname, search } = new URL(request.url);
    return Response.redirect(`https://notation.dev/yieldstar${pathname}${search}`, 301);
  },
};
