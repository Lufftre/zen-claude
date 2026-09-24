// Tool definitions exposed over MCP. Each tool is executed by the extension's
// background script under the same name.

const tabId = {
  type: 'number',
  description:
    "Target tab ID (from tabs_context). Defaults to the active tab of this session's window (see session_window), " +
    'or of the focused window.',
};
const ref = {
  type: 'string',
  description: 'Element reference from read_page or find, e.g. "ref_12".',
};
const coordinate = {
  type: 'array',
  items: { type: 'number' },
  minItems: 2,
  maxItems: 2,
  description: '[x, y] in CSS pixels relative to the viewport, matching screenshot pixels.',
};

export const TOOLS = [
  {
    name: 'session_window',
    description:
      'Give this session its own browser window. Afterwards tabs_context, tabs_create and calls without tabId use ' +
      'that window, and screenshots and input there no longer switch tabs in the window the user is looking at. ' +
      'Other sessions keep their own windows. Calling it again returns the existing window. close: true closes the ' +
      "window and goes back to sharing the user's focused window.",
    inputSchema: { type: 'object', properties: { close: { type: 'boolean' } } },
  },
  {
    name: 'tabs_context',
    description:
      "List open tabs (id, title, URL, active state) in this session's window (see session_window) or the focused " +
      'window, or in all windows.',
    inputSchema: {
      type: 'object',
      properties: { all_windows: { type: 'boolean', description: 'Include tabs from every window.' } },
    },
  },
  {
    name: 'tabs_create',
    description:
      "Open a new tab, optionally at a URL, in this session's window (see session_window) or the focused window. " +
      'The new tab becomes active.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
  },
  {
    name: 'tabs_close',
    description: 'Close a tab.',
    inputSchema: { type: 'object', properties: { tabId }, required: ['tabId'] },
  },
  {
    name: 'tabs_activate',
    description: 'Switch to (focus) a tab.',
    inputSchema: { type: 'object', properties: { tabId }, required: ['tabId'] },
  },
  {
    name: 'navigate',
    description: 'Navigate a tab to a URL and wait for it to load. Use "back" or "forward" for history navigation.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' }, tabId },
      required: ['url'],
    },
  },
  {
    name: 'computer',
    description: [
      'Interact with the page using mouse/keyboard-style actions or take screenshots.',
      'Actions:',
      '- screenshot: capture the visible viewport.',
      '- zoom: capture a region at full resolution; needs region [x0, y0, x1, y1].',
      '- left_click / right_click / double_click / triple_click / hover: at coordinate or ref.',
      '- left_click_drag: from start_coordinate to coordinate.',
      '- type: insert text into the focused element (or ref, which is focused first).',
      '- key: press keys, space-separated sequence, e.g. "Enter", "ctrl+a Backspace", "Tab".',
      '- scroll: scroll_direction up/down/left/right, scroll_amount in ticks (default 3), at coordinate or ref.',
      '- scroll_to: scroll the element given by ref into view.',
      '- wait: pause for duration seconds (max 30).',
      'In Zen (with extensions.experiments.enabled) input is browser-level and trusted, like a real user; otherwise it',
      'is synthesized in the page. Native <select> dropdowns and context menus are browser UI that screenshots cannot',
      'show - use form_input for <select>. The tab is activated before input is sent.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'screenshot', 'zoom', 'left_click', 'right_click', 'double_click', 'triple_click', 'hover',
            'left_click_drag', 'type', 'key', 'scroll', 'scroll_to', 'wait',
          ],
        },
        coordinate,
        start_coordinate: coordinate,
        ref,
        text: { type: 'string', description: 'Text for "type", key sequence for "key".' },
        region: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 },
        scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        scroll_amount: { type: 'number' },
        duration: { type: 'number' },
        modifiers: { type: 'string', description: 'Modifier keys held during a click, e.g. "shift" or "ctrl+shift".' },
        tabId,
      },
      required: ['action'],
    },
  },
  {
    name: 'read_page',
    description:
      'Get an accessibility-style tree of the page with element refs (ref_N) usable by computer, form_input and ' +
      'scroll_to. filter "interactive" (default) lists only actionable elements; "all" includes headings, text and ' +
      'landmarks. Pass ref_id to read only the subtree under an element.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', enum: ['interactive', 'all'] },
        ref_id: { type: 'string' },
        viewport_only: { type: 'boolean', description: 'Only include elements currently visible in the viewport.' },
        max_chars: { type: 'number', description: 'Truncate output (default 40000).' },
        tabId,
      },
    },
  },
  {
    name: 'find',
    description:
      'Find elements matching a description (text, label, placeholder, role, e.g. "search box" or "login button"). ' +
      'Returns matching elements with refs, best matches first.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, tabId },
      required: ['query'],
    },
  },
  {
    name: 'form_input',
    description:
      'Set the value of a form control by ref: text for inputs/textareas, option value or label for selects, ' +
      'true/false for checkboxes and radios.',
    inputSchema: {
      type: 'object',
      properties: { ref, value: { type: ['string', 'number', 'boolean'] }, tabId },
      required: ['ref', 'value'],
    },
  },
  {
    name: 'get_page_text',
    description: 'Get the readable text content of the page (prefers the main/article element).',
    inputSchema: {
      type: 'object',
      properties: { max_chars: { type: 'number', description: 'Truncate output (default 50000).' }, tabId },
    },
  },
  {
    name: 'javascript_tool',
    description:
      'Run JavaScript in the page (content-script context: full DOM access; page globals via window.wrappedJSObject). ' +
      'A single expression is returned as the result; for multiple statements use an explicit `return`. ' +
      '`await` is supported.',
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string' }, tabId },
      required: ['code'],
    },
  },
  {
    name: 'read_console_messages',
    description: 'Read console messages and uncaught errors captured from the page.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex to filter messages.' },
        only_errors: { type: 'boolean' },
        limit: { type: 'number', description: 'Max messages to return (default 100, newest last).' },
        clear: { type: 'boolean', description: 'Clear the buffer after reading.' },
        tabId,
      },
    },
  },
  {
    name: 'read_network_requests',
    description: 'Read network requests made by a tab since it was last navigated to a new document.',
    inputSchema: {
      type: 'object',
      properties: {
        url_pattern: { type: 'string', description: 'Substring or regex to filter URLs.' },
        limit: { type: 'number', description: 'Max requests to return (default 100, newest last).' },
        clear: { type: 'boolean' },
        tabId,
      },
    },
  },
  {
    name: 'split_view',
    description:
      'Zen only: show tabs side by side in split view. layout "vertical" = side by side (default), "horizontal" = ' +
      'stacked, "grid" = grid, "unsplit" = close the split containing tabIds[0]. Up to 4 tabs, same window.',
    inputSchema: {
      type: 'object',
      properties: {
        tabIds: { type: 'array', items: { type: 'number' }, minItems: 1, maxItems: 4 },
        layout: { type: 'string', enum: ['vertical', 'horizontal', 'grid', 'unsplit'] },
      },
      required: ['tabIds'],
    },
  },
  {
    name: 'resize_window',
    description: 'Resize the browser window containing the tab.',
    inputSchema: {
      type: 'object',
      properties: { width: { type: 'number' }, height: { type: 'number' }, tabId },
      required: ['width', 'height'],
    },
  },
];
