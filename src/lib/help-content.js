'use strict';
(function () {
  const links = {
    documentation: 'https://github.com/DorShaer/Husk#readme',
    repository: 'https://github.com/DorShaer/Husk',
    releases: 'https://github.com/DorShaer/Husk/releases',
  };
  const topics = {
    documentation: {
      title: 'Getting started with Husk',
      intro: 'A home for your CLI agents. These instructions are included with this version of Husk.',
      sections: [
        { title: 'Start a conversation', text: 'Choose New in the Sessions column, then choose a CLI. Type in the composer and press Enter. Use the model chip to choose a model that your CLI supports.' },
        { title: 'Keep your work together', text: 'Open a saved conversation from Sessions to continue it. Pin a folder in Projects so your chat, Files and Source control use the same workspace. The folder chip names the folder a chat is using.' },
        { title: 'While the agent works', text: 'Enter queues another message while a reply is running. Permission and question cards explain what needs your answer. Restart agent keeps the visible conversation and offers to wait for the reply to finish.' },
        { title: 'Files, tools and automation', text: 'Attach files or paste images in the composer. Skills and MCP manage the tools available to your agents. Workflows connect steps into a run; Autopilot runs a goal with the limits you choose.' },
        { title: 'Make it yours', text: 'Preferences contains Workspace, Appearance, Voice & recaps, Usage & limits, Connections, and About & help. Use Find a setting to search them. Workspace includes the default chat CLI and startup behavior.' },
      ],
    },
    shortcuts: {
      title: 'Keyboard shortcuts',
      intro: 'App shortcuts yield to terminal input. Navigation shortcuts do not change pages while you are typing in a field.',
      sections: [
        { title: 'Move around', rows: [['Ctrl/Cmd + Shift + K', 'Open the command palette from anywhere'], ['Ctrl/Cmd + K', 'Open the palette outside a terminal'], ['Alt + A', 'Open the Agents center outside text fields and terminals'], ['Alt + 1 / 2 / 3', 'Chat / Skills / Sessions'], ['Alt + 4 / 5 / 6 / 7', 'Files / MCP / Preferences / Agents library']] },
        { title: 'Write in native chat', rows: [['Enter', 'Send a message, or queue it while the agent replies'], ['Shift + Enter', 'Insert a new line'], ['Up / Down', 'Recall prompts when the composer is empty or already recalling history'], ['Escape', 'Dismiss the current overlay, or stop a reply from its composer']] },
        { title: 'Terminal input and window controls', rows: [['Ctrl + R / Ctrl + K / Ctrl + \\', 'Sent to the focused shell or CLI'], ['F5 / Ctrl/Cmd + Shift + R', 'Reload the window while keeping live sessions'], ['Ctrl/Cmd + R', 'Reload outside a terminal'], ['Ctrl/Cmd + \\', 'Toggle split view outside a terminal'], ['Ctrl/Cmd + plus / minus / 0', 'Zoom in / out / reset outside a terminal']] },
      ],
    },
    troubleshooting: {
      title: 'Troubleshooting',
      intro: 'Start with the status line for the active chat. It tells you whether the agent is working, waiting for you, signed out or stopped.',
      sections: [
        { title: 'A CLI will not start', text: 'Use Install or Choose another CLI on the recovery card. For sign-in, choose Sign in and complete the CLI’s own login. If a CLI is installed but Husk cannot find it, restart Husk after checking that the CLI is available on your PATH.' },
        { title: 'A conversation seems stuck', text: 'Check for a permission or question card first. If the agent has stopped, use Restart. During a reply you can restart now or after the reply. The conversation stays visible; a note explains when the CLI cannot resume its earlier context.' },
        { title: 'A project folder moved', text: 'Use Locate folder to point Husk at its new location. Use Recreate only when you want an empty folder at the original path. Husk will not silently switch the chat to another project.' },
        { title: 'The window is hard to read or stops updating', text: 'Use View > Actual size to reset zoom. View > Reload refreshes the window and reattaches live sessions. Use Ctrl/Cmd + Shift + R or F5 when the terminal has focus.' },
        { title: 'An MCP server needs attention', text: 'Open MCP and edit the server. Check that its command is installed and available on PATH, or use its full path. HTTP servers need a reachable URL and the authentication their provider requires.' },
        { title: 'Collect information for a bug report', text: 'Help > Open logs folder opens the local logs. Help > Copy diagnostics copies Husk, Electron, OS and CLI version details. Use Report a bug to add what you did and what happened. Review logs before sharing them.' },
      ],
    },
  };
  const api = { links, topics };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.HuskHelpContent = api;
})();
