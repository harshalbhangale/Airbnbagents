// Stands in for Playwright inside the desktop bundle, which never uses it.
export const chromium = {
  launchPersistentContext(): never {
    throw new Error("the desktop app uses its own built-in browser");
  },
};
