'use strict';

function collapseTitle(value, limit = 120) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      if (typeof part.text === 'string' && part.text.trim()) return part.text;
      if (typeof part.content === 'string' && part.content.trim()) return part.content;
    }
  }
  return '';
}

function userTextFromEvent(event) {
  if (!event || typeof event !== 'object') return '';
  const data = event.data && typeof event.data === 'object' ? event.data : {};
  const msg = event.message && typeof event.message === 'object' ? event.message : {};
  return textFromContent(data.content)
    || textFromContent(data.transformedContent)
    || textFromContent(data.message)
    || textFromContent(data.user_message)
    || textFromContent(data.prompt)
    || textFromContent(msg.content)
    || textFromContent(event.content)
    || textFromContent(event.user_content)
    || textFromContent(data.text)
    || textFromContent(event.text);
}

function titleFromEvent(event) {
  if (!event || typeof event !== 'object') return '';
  const data = event.data && typeof event.data === 'object' ? event.data : {};
  return collapseTitle(
    data.title
    || data.name
    || data.summary
    || event.title
    || event.name
    || event.summary
  );
}

function deriveCopilotSessionTitleFromEventsText(text) {
  let firstUser = '';
  let firstTitle = '';
  let sawAssistant = false;
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch (_) { continue; }
    const type = String((event && event.type) || '');
    if (!firstTitle && /(?:session|conversation|chat).*(?:title|name|summary)|(?:title|name|summary)$/.test(type)) {
      firstTitle = titleFromEvent(event);
    }
    if (!firstUser && (type === 'user.message' || type === 'user' || /^user[._-]/.test(type))) {
      firstUser = collapseTitle(userTextFromEvent(event));
    }
    if (!sawAssistant && (type === 'assistant.message' || type === 'assistant' || /^assistant[._-]/.test(type))) {
      sawAssistant = true;
    }
    if ((firstTitle || firstUser) && sawAssistant) break;
  }
  return {
    title: firstTitle || firstUser,
    firstMessage: firstUser || firstTitle,
    // A title the CLI generated itself, as opposed to the first-user-message
    // fallback above. Consumers use this to tell a real name from filler.
    generatedTitle: firstTitle,
    sawAssistant,
  };
}

module.exports = {
  collapseTitle,
  deriveCopilotSessionTitleFromEventsText,
  textFromContent,
};
