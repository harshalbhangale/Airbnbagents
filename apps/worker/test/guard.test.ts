import { describe, expect, it } from "vitest";
import { resolverRules } from "../src/browser.ts";
import { guardDecision } from "../src/site-browser.ts";

const rules = { origin: "https://meshwork.test", blockedPathPrefixes: ["/messages", "/api/messages", "/settings"] };
const task = { ...rules, taskMode: true };
const setup = { ...rules, taskMode: false };

describe("network guard", () => {
  it.each([
    ["a profile page", "https://meshwork.test/in/jordan-lee", "GET", "allow"],
    ["a page with a query string", "https://meshwork.test/in/jordan-lee?x=1", "GET", "allow"],
    ["a path that only starts like a blocked one", "https://meshwork.test/messages-help", "GET", "allow"],
    ["the inbox", "https://meshwork.test/messages", "GET", "blocked_path"],
    ["a thread inside the inbox", "https://meshwork.test/messages/42", "GET", "blocked_path"],
    ["the inbox preview API", "https://meshwork.test/api/messages/preview", "GET", "blocked_path"],
    ["account settings", "https://meshwork.test/settings", "GET", "blocked_path"],
    ["another site", "https://evil.example/collect", "GET", "off_origin"],
    ["the same host on plain http", "http://meshwork.test/in/jordan-lee", "GET", "off_origin"],
    ["the same host on another port", "https://meshwork.test:8443/in/jordan-lee", "GET", "off_origin"],
    ["a lookalike host", "https://meshwork.test.evil.example/in/jordan-lee", "GET", "off_origin"],
    ["a credentialed lookalike", "https://meshwork.test@evil.example/", "GET", "off_origin"],
    ["a local file", "file:///etc/passwd", "GET", "off_origin"],
    ["something that is not a URL", "not a url", "GET", "off_origin"],
    ["a form post", "https://meshwork.test/in/jordan-lee", "POST", "blocked_method"],
    ["a delete", "https://meshwork.test/in/jordan-lee", "DELETE", "blocked_method"],
    ["a websocket to the site", "wss://meshwork.test/live", "GET", "blocked_method"],
    ["a websocket elsewhere", "wss://evil.example/live", "GET", "off_origin"],
  ])("during a task, %s is %s → %s", (_label, url, method, expected) => {
    expect(guardDecision({ url, method }, task)).toBe(expected);
  });

  it("lets the host's own setup submit the sign-in form, but still nothing off-site or blocked", () => {
    expect(guardDecision({ url: "https://meshwork.test/login", method: "POST" }, setup)).toBe("allow");
    expect(guardDecision({ url: "https://meshwork.test/messages", method: "GET" }, setup)).toBe("blocked_path");
    expect(guardDecision({ url: "https://evil.example/", method: "POST" }, setup)).toBe("off_origin");
  });
});

describe("host-name restriction", () => {
  it("lets the browser resolve the allowed site and nothing else", () => {
    expect(resolverRules("meshwork.test", {})).toBe("MAP * ~NOTFOUND, EXCLUDE meshwork.test");
  });

  it("also lets it reach a configured network proxy, or nothing would load", () => {
    expect(resolverRules("meshwork.test", { HTTPS_PROXY: "http://127.0.0.1:3128" })).toBe("MAP * ~NOTFOUND, EXCLUDE meshwork.test, EXCLUDE 127.0.0.1");
    expect(resolverRules("meshwork.test", { https_proxy: "http://user:secret@proxy.corp.example:8080", HTTP_PROXY: "proxy.corp.example:8080" })).toBe(
      "MAP * ~NOTFOUND, EXCLUDE meshwork.test, EXCLUDE proxy.corp.example",
    );
    expect(resolverRules("meshwork.test", { ALL_PROXY: "socks5://[::1]:1080" })).toBe("MAP * ~NOTFOUND, EXCLUDE meshwork.test, EXCLUDE ::1");
  });

  it("never puts proxy credentials or junk into the browser flag", () => {
    const rules = resolverRules("meshwork.test", { HTTPS_PROXY: "http://user:secret@proxy.corp.example:8080", HTTP_PROXY: "http://", ALL_PROXY: "::::" });
    expect(rules).not.toContain("secret");
    expect(rules).toBe("MAP * ~NOTFOUND, EXCLUDE meshwork.test, EXCLUDE proxy.corp.example");
  });
});
