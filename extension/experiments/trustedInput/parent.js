/* Claude for Zen – privileged experiment API.
 *
 * Runs in the parent process with chrome privileges. Input is synthesized on the browser window at the position
 * of the tab's <browser> element, so it travels the same route as real OS input: the parent's event state manager
 * forwards it to the content process, and the page sees ordinary trusted events. */

/* global ExtensionAPI, ChromeUtils, Services, Cc, Ci */
"use strict";

const { ExtensionUtils } = ChromeUtils.importESModule("resource://gre/modules/ExtensionUtils.sys.mjs");
const { ExtensionError } = ExtensionUtils;
const { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");

// Mozilla's test/WebDriver input helpers, shipped with the browser's remote agent.
const EVENT_UTILS_URL = "chrome://remote/content/external/EventUtils.js";
const eventUtilsByWindow = new WeakMap();

function eventUtils(win) {
  let eu = eventUtilsByWindow.get(win);
  if (!eu) {
    // EventUtils expects to run in a window scope and refers to some DOM globals directly.
    eu = {
      window: win,
      parent: win,
      navigator: win.navigator,
      document: win.document,
      KeyboardEvent: win.KeyboardEvent,
      MouseEvent: win.MouseEvent,
      WheelEvent: win.WheelEvent,
      _EU_Ci: Ci,
      _EU_Cc: Cc,
    };
    Services.scriptloader.loadSubScript(EVENT_UTILS_URL, eu);
    eventUtilsByWindow.set(win, eu);
  }
  return eu;
}

// Browser shortcuts that would destroy state out from under the agent.
function isBlockedShortcut({ key, ctrlKey, metaKey }) {
  const accel = Services.appinfo.OS === "Darwin" ? metaKey : ctrlKey;
  return accel && ["q", "w"].includes(String(key).toLowerCase());
}

const TEST_MODE_PREF = "focusmanager.testmode";

// Key events go to the focused element of Gecko's *active* window, and a first click on an inactive window is spent
// trying to activate it. When another app is in front there is no active Zen window, so input would be lost.
// With focusmanager.testmode set, raising a window only updates Gecko's focus state instead of asking the OS to
// bring the app forward, so the window becomes active for input without stealing the user's focus.
async function activateWithoutRaising(win) {
  if (Services.focus.activeWindow === win) return;
  const wasSet = Services.prefs.prefHasUserValue(TEST_MODE_PREF);
  Services.prefs.setBoolPref(TEST_MODE_PREF, true);
  try {
    win.focus();
    for (let i = 0; i < 50 && Services.focus.activeWindow !== win; i++) {
      await new Promise(r => win.setTimeout(r, 10));
    }
  } finally {
    if (!wasSet) Services.prefs.clearUserPref(TEST_MODE_PREF);
  }
}

// Move browser focus into the tab (e.g. away from the URL bar of a new tab). Otherwise the first mousedown is spent
// shifting focus to the <browser> and never reaches the page. Leaves focus inside the page alone.
function focusBrowser(browser) {
  if (Services.focus.focusedElement !== browser) browser.focus();
}

const LABEL_ID = "claude-for-zen-window-label";

// Zen hides the window title and usually the extension's toolbar button, so a session's window is named by a label
// at the top of its sidebar instead.
function setWindowLabel(win, text, tooltip, onClick) {
  const doc = win.document;
  let label = doc.getElementById(LABEL_ID);
  if (text == null) return label?.remove();
  if (!label) {
    label = doc.createElementNS("http://www.w3.org/1999/xhtml", "button");
    label.id = LABEL_ID;
    label.style.cssText =
      "display: block; margin: 6px 8px; padding: 4px 8px; border: 0; border-radius: 6px; background: #d97757; " +
      "color: #fff; font: 600 12px system-ui, sans-serif; text-align: start; overflow-wrap: anywhere; " +
      "cursor: pointer; -moz-window-dragging: no-drag;";
    label.addEventListener("click", onClick);
    // Above the tab list, under Zen's URL bar; in Firefox, at the top of the toolbars.
    const tabs = doc.getElementById("tabbrowser-tabs");
    if (tabs && Services.prefs.getBoolPref("zen.tabs.vertical", false)) tabs.before(label);
    else doc.getElementById("navigator-toolbox")?.prepend(label);
  }
  label.textContent = text;
  label.title = tooltip || "";
}

this.trustedInput = class extends ExtensionAPI {
  onShutdown() {
    for (const win of Services.wm.getEnumerator("navigator:browser")) setWindowLabel(win, null);
  }

  getAPI(context) {
    const { tabManager } = context.extension;
    const labelClickListeners = new Set();

    function resolve(tabId) {
      let nativeTab;
      try {
        nativeTab = tabManager.get(tabId).nativeTab;
      } catch {
        throw new ExtensionError(`Invalid tab ID: ${tabId}`);
      }
      const browser = nativeTab.linkedBrowser;
      const win = browser.ownerDocument.defaultView;
      const rect = browser.getBoundingClientRect();
      if (!rect.width || !rect.height) {
        throw new ExtensionError("The tab is not visible; activate it first.");
      }
      // Content CSS px -> chrome CSS px (differs when the page is zoomed).
      const zoom = browser.fullZoom || 1;
      const toChrome = (x, y) => [rect.left + x * zoom, rect.top + y * zoom];
      return { browser, win, toChrome };
    }

    function modifiersOf(e) {
      return {
        shiftKey: !!e.shiftKey,
        ctrlKey: !!e.ctrlKey,
        altKey: !!e.altKey,
        metaKey: !!e.metaKey,
      };
    }

    // Firefox replaces non-ExtensionError exceptions with "An unexpected error occurred"; keep the real message.
    const api = {
        // Zen split view. layout: "vertical" (side by side), "horizontal" (stacked), "grid" or "unsplit".
        async splitView(tabIds, layout) {
          const tabs = tabIds.map(id => {
            try {
              return tabManager.get(id).nativeTab;
            } catch {
              throw new ExtensionError(`Invalid tab ID: ${id}`);
            }
          });
          const win = tabs[0].ownerDocument.defaultView;
          const splitter = win.gZenViewSplitter;
          if (!splitter) {
            throw new ExtensionError("Split view is only available in Zen.");
          }
          if (tabs.some(t => t.ownerDocument.defaultView !== win)) {
            throw new ExtensionError("All tabs must be in the same window.");
          }
          if (layout === "unsplit") {
            win.gBrowser.selectedTab = tabs[0];
            splitter.unsplitCurrentView();
            return;
          }
          const gridType = { vertical: "vsep", horizontal: "hsep", grid: "grid" }[layout];
          if (!gridType) {
            throw new ExtensionError(`Unknown layout: ${layout}`);
          }
          if (tabs.length < 2) {
            throw new ExtensionError("Split view needs at least two tabs.");
          }
          splitter.splitTabs(tabs, gridType);
        },

        // A new browser window. In Zen it is opened unsynced: synced windows mirror each other's tabs and move a
        // tab's page into whichever window selects it, so a synced window can't be driven independently.
        async openWindow() {
          // Same as Zen's "New Unsynced Window" command.
          const opener = Services.wm.getMostRecentWindow("navigator:browser");
          const openerWasActive = Services.focus.activeWindow === opener;
          const win = opener.OpenBrowserWindow({ zenSyncedWindow: false });
          await new Promise(resolve => {
            const observer = subject => {
              if (subject !== win) return;
              Services.obs.removeObserver(observer, "browser-delayed-startup-finished");
              resolve();
            };
            Services.obs.addObserver(observer, "browser-delayed-startup-finished");
          });
          // Put the user's window back in front; the new one stays behind it.
          if (openerWasActive) opener.focus();
          return context.extension.windowManager.getWrapper(win).id;
        },

        // Gecko's active window, which receives key events. Input into a background window takes it over, so callers
        // hand it back afterwards with activateWindow.
        async activeWindowId() {
          const win = Services.focus.activeWindow;
          if (!win || win.document.documentElement.getAttribute("windowtype") !== "navigator:browser") return -1;
          return context.extension.windowManager.getWrapper(win).id;
        },

        async activateWindow(windowId) {
          const win = context.extension.windowManager.get(windowId, context)?.window;
          if (win) await activateWithoutRaising(win);
        },

        async labelWindow(windowId, text, tooltip) {
          const win = context.extension.windowManager.get(windowId, context)?.window;
          if (!win) throw new ExtensionError(`Invalid window ID: ${windowId}`);
          setWindowLabel(win, text, tooltip, () => {
            for (const fire of labelClickListeners) fire.async(windowId);
          });
        },

        // Replaces this add-on with the package at path, which reloads it. The caller doesn't get an answer, since
        // the extension shuts down during the install.
        async installXpi(path) {
          const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
          const self = await AddonManager.getAddonByID(context.extension.id);
          if (self?.temporarilyInstalled) throw new ExtensionError("A temporarily loaded add-on is not updated.");
          const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
          file.initWithPath(path);
          if (!path.endsWith(".xpi") || !file.exists()) throw new ExtensionError(`No package at ${path}`);
          const install = await AddonManager.getInstallForFile(file);
          if (install.state === AddonManager.STATE_DOWNLOAD_FAILED || install.addon?.id !== context.extension.id) {
            throw new ExtensionError(`${path} is not a package of this add-on.`);
          }
          install.install();
        },

        async status() {
          try {
            eventUtils(Services.wm.getMostRecentWindow("navigator:browser"));
            return { available: true };
          } catch (e) {
            return { available: false, reason: String(e) };
          }
        },

        async mouse(tabId, events) {
          const { browser, win, toChrome } = resolve(tabId);
          await activateWithoutRaising(win);
          focusBrowser(browser);
          const eu = eventUtils(win);
          let defaultPrevented = false;
          for (const e of events) {
            const [x, y] = toChrome(e.x, e.y);
            defaultPrevented =
              eu.synthesizeMouseAtPoint(
                x,
                y,
                {
                  type: e.type,
                  button: e.button ?? 0,
                  buttons: e.buttons,
                  clickCount: e.clickCount ?? 1,
                  isSynthesized: false,
                  isWidgetEventSynthesized: false,
                  ...modifiersOf(e),
                },
                win
              ) || defaultPrevented;
          }
          return { defaultPrevented };
        },

        async wheel(tabId, x, y, deltaX, deltaY) {
          const { browser, win, toChrome } = resolve(tabId);
          await activateWithoutRaising(win);
          focusBrowser(browser);
          const [cx, cy] = toChrome(x, y);
          await new Promise(done =>
            eventUtils(win).synthesizeWheelAtPoint(
              cx,
              cy,
              { deltaMode: 0, deltaX, deltaY, isNoLineOrPageDelta: true },
              win,
              done
            )
          );
        },

        async keys(tabId, keys) {
          const { browser, win } = resolve(tabId);
          const blocked = keys.find(isBlockedShortcut);
          if (blocked) {
            throw new ExtensionError(`Refusing to send browser shortcut "${blocked.key}" with accel; use tabs_close instead.`);
          }
          await activateWithoutRaising(win);
          focusBrowser(browser);
          const eu = eventUtils(win);
          for (const k of keys) {
            const key = k.key.length === 1 || /^[\uD800-\uDBFF][\uDC00-\uDFFF]$/.test(k.key) ? k.key : `KEY_${k.key}`;
            eu.synthesizeKey(key, { ...modifiersOf(k), isSynthesized: false }, win);
          }
        },

        async text(tabId, text) {
          const { browser, win } = resolve(tabId);
          await activateWithoutRaising(win);
          focusBrowser(browser);
          const eu = eventUtils(win);
          // Plain runs go through sendString (handles shift state and surrogate pairs); \n and \t are real key presses.
          for (const part of text.split(/([\n\t])/)) {
            if (part === "\n") eu.synthesizeKey("KEY_Enter", {}, win);
            else if (part === "\t") eu.synthesizeKey("KEY_Tab", {}, win);
            else if (part) eu.sendString(part, win);
          }
        },

        // Close browser-level popups opened by a synthesized click (context menu, <select> dropdown). They are
        // drawn outside the page, so screenshots can't show them and page input can't reach them.
        async dismissPopups(tabId) {
          const { win } = resolve(tabId);
          const closed = [];
          for (const id of ["contentAreaContextMenu", "ContentSelectDropdown"]) {
            const el = win.document.getElementById(id);
            const popup = el?.localName === "menulist" ? el.menupopup : el;
            if (popup && (popup.state === "open" || popup.state === "showing")) {
              popup.hidePopup();
              closed.push(id === "contentAreaContextMenu" ? "context menu" : "select dropdown");
            }
          }
          return closed;
        },
    };

    const wrapped = {};
    for (const [name, fn] of Object.entries(api)) {
      wrapped[name] = async (...args) => {
        try {
          return await fn(...args);
        } catch (e) {
          if (e instanceof ExtensionError) throw e;
          throw new ExtensionError(`trustedInput.${name}: ${e?.message || e}`);
        }
      };
    }
    wrapped.onWindowLabelClicked = new ExtensionCommon.EventManager({
      context,
      name: "trustedInput.onWindowLabelClicked",
      register: fire => {
        labelClickListeners.add(fire);
        return () => labelClickListeners.delete(fire);
      },
    }).api();
    return { trustedInput: wrapped };
  }
};
