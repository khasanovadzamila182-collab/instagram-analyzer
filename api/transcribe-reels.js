// api/transcribe-reels.js
// OpenAI Whisper + Claude — лучшая транскрибация узбекского

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { username, reels } = req.body;
  if (!username || !reels || !reels.length) {
    return res.status(400).json({ error: 'username и reels обязательны' });
  }

  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  if (!OPENAI_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY не настроен' });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY не настроен' });

  const transcripts = [];
  let transcribedCount = 0;

  // Берём максимум 5 роликов за раз чтобы не превысить timeout
  const reelsToProcess = reels.slice(0, 5);

  for (const reel of reelsToProcess) {
    const date = reel.timestamp
      ? new Date(reel.timestamp * 1000).toLocaleDateString('ru')
      : '—';

    if (!reel.videoUrl) {
      transcripts.push({ date, likes: reel.likesCount || 0, comments: reel.commentsCount || 0, caption: reel.caption || '', transcript: '(видео URL недоступен)' });
      continue;
    }

    try {
      const transcript = await transcribeWithWhisper(reel.videoUrl, OPENAI_KEY);
      transcripts.push({ date, likes: reel.likesCount || 0, comments: reel.commentsCount || 0, caption: reel.caption || '', transcript });
      transcribedCount++;
    } catch (err) {
      console.error('Whisper error:', err.message);
      transcripts.push({ date, likes: reel.likesCount || 0, comments: reel.commentsCount || 0, caption: reel.caption || '', transcript: '(не удалось: ' + err.message + ')' });
    }
  }

  const avgLikes = Math.round(reels.reduce((s, r) => s + (r.likesCount || 0), 0) / reels.length);
  const analysis = await analyzeWithClaude(username, transcripts, ANTHROPIC_KEY);

  return res.status(200).json({
    username, totalSelected: reels.length, transcribedCount,
    avgLikes, avgComments: Math.round(reels.reduce((s, r) => s + (r.commentsCount || 0), 0) / reels.length),
    erRate: '—', followers: '—', analysis, transcripts,
  });
}

async function transcribeWithWhisper(videoUrl, apiKey) {
  // Скачиваем видео
  const videoRes = await fetch(videoUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X)' },
  });

  if (!videoRes.ok) throw new Error('Не удалось скачать видео: ' + videoRes.status);

  const videoBuffer = await videoRes.arrayBuffer();
  const videoBytes = new Uint8Array(videoBuffer);

  if (videoBytes.length < 1000) throw new Error('Файл слишком маленький');

  // Отправляем в Whisper как multipart/form-data
  const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);

  // Собираем multipart вручную
  const header = '--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="audio.mp4"\r\nContent-Type: video/mp4\r\n\r\n';
  const modelPart = '\r\n--' + boundary + '\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1';
  const langPart = '\r\n--' + boundary + '\r\nContent-Disposition: form-data; name="language"\r\n\r\nuz';
  const promptPart = '\r\n--' + boundary + '\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nBu uzbek tilidagi video. Aniq transkripsiya qiling.';
  const footer = '\r\n--' + boundary + '--\r\n';

  const headerBytes = new TextEncoder().encode(header);
  const middleBytes = new TextEncoder().encode(modelPart + langPart + promptPart + footer);

  const body = new Uint8Array(headerBytes.length + videoBytes.length + middleBytes.length);
  body.set(headerBytes, 0);
  body.set(videoBytes, headerBytes.length);
  body.set(middleBytes, headerBytes.length + videoBytes.length);

  const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'multipart/form-data; boundary=' + boundary,
    },
    body: body,
  });

  if (!whisperRes.ok) {
    const err = await whisperRes.text();
    throw new Error('Whisper: ' + err);
  }

  const data = await whisperRes.json();
  return data.text || '(пустая транскрипция)';
}

async function analyzeWithClaude(username, transcripts, apiKey) {
  const successful = transcripts
    .filter(t => t.transcript && !t.transcript.startsWith('('))
    .map((t, i) => 'REEL ' + (i+1) + ' (❤️' + t.likes + '):\nОписание: ' + t.caption + '\nТранскрипция: ' + t.transcript)
    .join('\n\n');

  if (!successful) return 'Транскрипции недоступны. Попробуй снова.';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 3000,
      messages: [{ role: 'user', content: 'Ты эксперт по Instagram контент-маркетингу. Проанализируй аккаунт @' + username + ' на основе транскрипций ' + transcripts.length + ' Reels.\n\n' + successful + '\n\nДай ГЛУБОКИЙ анализ:\n1. ГОЛОС И СТИЛЬ АВТОРА — как говорит, характерные фразы\n2. ОСНОВНЫЕ ТЕМЫ — о чём контент\n3. СТРУКТУРА РОЛИКОВ — как строит видео\n4. ЧТО РАБОТАЕТ — какие ролики набирают больше лайков и почему\n5. АУДИТОРИЯ — кто смотрит, к кому обращается\n6. TOF/MOF/BOF — разбивка контента по воронке\n7. КОНКРЕТНЫЕ РЕКОМЕНДАЦИИ — 5 действий для роста\n\nПиши на русском языке. Ссылайся на конкретные фразы из транскрипций.' }],
    }),
  });

  if (!res.ok) return '(ошибка анализа: ' + await res.text() + ')';
  const data = await res.json();
  return data.content?.[0]?.text || '(недоступно)';
}
