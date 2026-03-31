// api/transcribe-reels.js
// AssemblyAI + Claude

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { username, reels } = req.body;
  if (!username || !reels || !reels.length) {
    return res.status(400).json({ error: 'username и reels обязательны' });
  }

  const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_API_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  if (!ASSEMBLYAI_KEY) return res.status(500).json({ error: 'ASSEMBLYAI_API_KEY не настроен' });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY не настроен' });

  const transcripts = [];
  let transcribedCount = 0;

  for (const reel of reels) {
    const date = reel.timestamp
      ? new Date(reel.timestamp * 1000).toLocaleDateString('ru')
      : '—';

    if (!reel.videoUrl) {
      transcripts.push({ date, likes: reel.likesCount || 0, comments: reel.commentsCount || 0, caption: reel.caption || '', transcript: '(видео URL недоступен)' });
      continue;
    }

    try {
      const transcript = await transcribeWithAssemblyAI(reel.videoUrl, ASSEMBLYAI_KEY);
      transcripts.push({ date, likes: reel.likesCount || 0, comments: reel.commentsCount || 0, caption: reel.caption || '', transcript });
      transcribedCount++;
    } catch (err) {
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

async function transcribeWithAssemblyAI(audioUrl, apiKey) {
  const submitRes = await fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST',
    headers: { 
      'Authorization': apiKey, 
      'Content-Type': 'application/json' 
    },
    body: JSON.stringify({
      audio_url: audioUrl,
      speech_models: ['universal-2'],
      language_detection: true,
    }),
  });

  if (!submitRes.ok) {
    const err = await submitRes.text();
    throw new Error('AssemblyAI error: ' + err);
  }

  const { id } = await submitRes.json();

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const pollRes = await fetch('https://api.assemblyai.com/v2/transcript/' + id, {
      headers: { 'Authorization': apiKey },
    });
    const poll = await pollRes.json();
    if (poll.status === 'completed') return poll.text || '(пустая транскрипция)';
    if (poll.status === 'error') throw new Error(poll.error);
  }
  throw new Error('Timeout');
}

async function analyzeWithClaude(username, transcripts, apiKey) {
  const successful = transcripts
    .filter(t => t.transcript && !t.transcript.startsWith('('))
    .map((t, i) => 'REEL ' + (i+1) + ':\nОписание: ' + t.caption + '\nТекст: ' + t.transcript)
    .join('\n\n');

  if (!successful) return 'Транскрипции недоступны. Попробуй снова.';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 3000,
      messages: [{ role: 'user', content: 'Проанализируй аккаунт @' + username + ' на основе транскрипций ' + transcripts.length + ' Reels.\n\n' + successful + '\n\nДай анализ:\n1. ГОЛОС И СТИЛЬ\n2. ТЕМЫ\n3. СТРУКТУРА\n4. ЧТО РАБОТАЕТ\n5. АУДИТОРИЯ\n6. TOF/MOF/BOF\n7. РЕКОМЕНДАЦИИ\n\nПиши на русском.' }],
    }),
  });

  if (!res.ok) return '(ошибка анализа)';
  const data = await res.json();
  return data.content?.[0]?.text || '(недоступно)';
}
