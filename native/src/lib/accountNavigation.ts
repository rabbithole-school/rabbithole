type AccountRouter = {
  canGoBack: () => boolean;
  back: () => void;
  replace: (href: "/") => void;
};

export function leaveAccount(router: AccountRouter) {
  if (router.canGoBack()) {
    router.back();
    return;
  }

  router.replace("/");
}
