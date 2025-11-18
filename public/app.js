// public/app.js

const chatEl = document.getElementById('chat');
const formEl = document.getElementById('chat-form');
const inputEl = document.getElementById('user-input');

let messageHistory = [
  {
    role: 'system',
    content: 'You are a helpful assistant running in a local UI similar to ChatGPT.',
  },
];

// ----------------------------------------------------
// Add message to UI
// ----------------------------------------------------
function addMessage(role, text) {
  const row = document.createElement('div');
  row.className = `message-row ${role === 'user' ? 'user' : 'assistant'}`;

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.textContent = text;

  row.appendChild(bubble);
  chatEl.appendChild(row);
  chatEl.scrollTop = chatEl.scrollHeight;
}

// ----------------------------------------------------
// Submit / Send message
// ----------------------------------------------------
formEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;

  // Add user message visually
  addMessage('user', text);

  // Add to chat history
  messageHistory.push({ role: 'user', content: text });

  // Clear input
  inputEl.value = '';
  resizeTextarea();

  // Disable UI while waiting
  const submitButton = formEl.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = 'Thinking...';

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: messageHistory }),
    });

    const data = await res.json();

    if (data.error) {
      addMessage('assistant', `Error: ${data.error}`);
    } else {
      addMessage('assistant', data.reply);
      messageHistory.push({ role: 'assistant', content: data.reply });
    }
  } catch (err) {
    console.error(err);
    addMessage('assistant', 'Error talking to server.');
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = 'Send';
  }
});

// ----------------------------------------------------
// Auto-resize textarea
// ----------------------------------------------------
function resizeTextarea() {
  inputEl.style.height = 'auto';
  inputEl.style.height = inputEl.scrollHeight + 'px';
}
inputEl.addEventListener('input', resizeTextarea);
resizeTextarea();

// ----------------------------------------------------
// ENTER = SEND, SHIFT+ENTER = NEW LINE
// ----------------------------------------------------
inputEl.addEventListener('keydown', (e) => {
  // Enter without Shift → send message
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    formEl.dispatchEvent(new Event('submit'));
  }
  // Shift+Enter = regular newline
});
