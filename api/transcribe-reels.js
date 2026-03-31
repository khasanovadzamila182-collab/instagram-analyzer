// api/transcribe-reels.js
// Транскрибирует Reels через AssemblyAI (асинхронно) + анализ через Claude
// ENV: ASSEMBLYAI_API_KEY, ANTHROPIC_API_KEY

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
      transcripts.push({
        date, likes: reel.likesCount || 0,
        comments: reel.commentsCount || 0,
        caption: reel.caption || '',
        transcript: '(видео URL недоступен)',
      });
      continue;
    }

    try {
      const transcript = await transcribeWithAssemblyAI(reel.videoUrl, ASSEMBLYAI_KEY);
      transcripts.push({
        date, likes: reel.likesCount || 0,
        comments: reel.commentsCount || 0,
        caption: reel.caption || '',
        transcript,
      });
      transcribedCount++;
    } catch (err) {
      console.error('Transcription error:', err.message);
      transcripts.push({
        date, likes: reel.likesCount || 0,
        comments: reel.commentsCount || 0,
        caption: reel.caption || '',
        transcript: '(не удалось: ' + err.message + ')',
      });
    }
  }

  const avgLikes = Math.round(
    reels.reduce((s, r) => s + (r.likesCount || 0), 0) / reels.length
  );

  const analysis = await analyzeWithClaude(username, transcripts, reels, ANTHROPIC_KEY);

  return res.status(200).json({
    username,
    totalSelected: reels.length,
    transcribedCount,
    avgLikes,
    avgComments: Math.round(reels.reduce((s, r) => s + (r.commentsCount || 0), 0) / reels.length),
    erRate: '—',
    followers: '—',
    analysis,
    transcripts,
  });
}

async function transcribeWithAssemblyAI(audioUrl, apiKey) {
  const submitRes = await fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST',
    headers: {
      'Authorization': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      audio_url: audioUrl,
      language_detection: true,
    }),
  });

  if (!submitRes.ok) {
    const err = await submitRes.text();
    throw new Error('AssemblyAI submit error: ' + err);
  }

  const submitData = await submitRes.json();
  const transcriptId = submitData.id;

  let attempts = 0;
  while (attempts < 60) {
    await sleep(3000);
    attempts++;

    const pollRes = await fetch('https://api.assemblyai.com/v2/transcript/' + transcriptId, {
      headers: { 'Authorization': apiKey },
    });

    const pollData = await pollRes.json();

    if (pollData.status === 'completed') {
      return pollData.text || '(пустая транскрипция)';
    }

    if (pollData.status === 'error') {
      throw new Error('AssemblyAI error: ' + pollData.error);
    }
  }

  throw new Error('AssemblyAI timeout');
}

async function analyzeWithClaude(username, transcripts, reels, apiKey) {
  const successful = transcripts
    .filter(t => t.transcript && !t.transcript.startsWith('('))
    .map((t, i) =>
      '--- REEL ' + (i+1) + ' ---\nДата: ' + t.date + ' | Лайки: ' + t.likes + '\nОписание: ' + t.caption + '\nТранскрипция: ' + t.transcript
    ).join('\n\n');

  if (!successful) {
    return 'Не удалось получить транскрипции для анализа.';
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 3000,
      messages: [{
        role: 'user',
        content: 'Ты эксперт по контент-маркетингу. Проанализируй аккаунт @' + username + ' на основе транскрипций ' + transcripts.length + ' Reels.\n\nТРАНСКРИПЦИИ:\n' + successful + '\n\nДай анализ по разделам:\n1. ГОЛОС И СТИЛЬ АВТОРА\n2. ОСНОВНЫЕ ТЕМЫ\n3. СТРУКТУРА КОНТЕНТА\n4. ЧТО РАБОТАЕТ ЛУЧШЕ ВСЕГО\n5. АУДИТОРИЯ\n6. TOF/MOF/BOF\n7. РЕКОМЕНДАЦИИ (5 штук)\n\nПиши на русском языке.',
      }],
    }),
  });

  if (!response.ok) return '(ошибка анализа)';
  const data = await response.json();
  return data.content?.[0]?.text || '(анализ недоступен)';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
