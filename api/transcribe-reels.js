// api/transcribe-reels.js
// Транскрибирует выбранные Reels через OpenAI Whisper + анализ через Claude
// ENV: OPENAI_API_KEY, ANTHROPIC_API_KEY, APIFY_TOKEN

import fetch from 'node-fetch';
import FormData from 'form-data';

export const config = {
  maxDuration: 300, // 5 минут — Vercel Pro
};

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

  // Транскрибируем каждый Reel
  for (const reel of reels) {
    const date = reel.timestamp
      ? new Date(reel.timestamp * 1000).toLocaleDateString('ru')
      : '—';

    if (!reel.videoUrl) {
      transcripts.push({
        date,
        likes: reel.likesCount || 0,
        comments: reel.commentsCount || 0,
        caption: reel.caption || '',
        transcript: '(видео URL недоступен)',
      });
      continue;
    }

    try {
      // 1. Скачиваем аудио из видео URL
      const audioBuffer = await downloadAudio(reel.videoUrl);

      // 2. Транскрибируем через Whisper
      const transcript = await transcribeWithWhisper(audioBuffer, OPENAI_KEY);

      transcripts.push({
        date,
        likes: reel.likesCount || 0,
        comments: reel.commentsCount || 0,
        caption: reel.caption || '',
        transcript,
      });
      transcribedCount++;

    } catch (err) {
      console.error(`Transcription failed for reel ${reel.id}:`, err.message);
      transcripts.push({
        date,
        likes: reel.likesCount || 0,
        comments: reel.commentsCount || 0,
        caption: reel.caption || '',
        transcript: `(не удалось: ${err.message})`,
      });
    }
  }

  // Собираем данные профиля из первых постов
  const avgLikes = Math.round(
    reels.reduce((sum, r) => sum + (r.likesCount || 0), 0) / reels.length
  );
  const avgComments = Math.round(
    reels.reduce((sum, r) => sum + (r.commentsCount || 0), 0) / reels.length
  );

  // Claude анализ всего контента
  const analysis = await analyzeWithClaude(
    username,
    transcripts,
    reels,
    ANTHROPIC_KEY
  );

  return res.status(200).json({
    username,
    totalSelected: reels.length,
    transcribedCount,
    avgLikes,
    avgComments,
    erRate: '—',
    followers: '—',
    analysis,
    transcripts,
  });
}

// Скачивает видео и возвращает Buffer с аудио
async function downloadAudio(videoUrl) {
  const response = await fetch(videoUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X)',
    },
    timeout: 30000,
  });

  if (!response.ok) throw new Error(`HTTP ${response.status} при скачивании видео`);

  const buffer = await response.buffer();
  if (buffer.length < 1000) throw new Error('Файл слишком маленький или защищён');

  return buffer;
}

// Транскрибирует аудио через OpenAI Whisper
async function transcribeWithWhisper(audioBuffer, apiKey) {
  const form = new FormData();

  // Отправляем как mp4 (Instagram reels — mp4)
  form.append('file', audioBuffer, {
    filename: 'audio.mp4',
    contentType: 'video/mp4',
  });
  form.append('model', 'whisper-1');

  // Подсказка для лучшего распознавания узбекского и русского
  form.append('prompt', 'Это видео на узбекском или русском языке. Транскрибируй точно.');
  form.append('response_format', 'text');

  // Не указываем language чтобы Whisper сам определил (узб/рус)

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...form.getHeaders(),
    },
    body: form,
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Whisper error: ${err}`);
  }

  const text = await response.text();
  return text.trim() || '(пустая транскрипция)';
}

// Claude анализ всего контента
async function analyzeWithClaude(username, transcripts, reels, apiKey) {
  const successfulTranscripts = transcripts
    .filter(t => t.transcript && !t.transcript.startsWith('('))
    .map((t, i) => `--- REEL ${i + 1} ---\nДата: ${t.date} | ❤️ ${t.likes} 💬 ${t.comments}\nОписание: ${t.caption}\nТранскрипция: ${t.transcript}`)
    .join('\n\n');

  if (!successfulTranscripts) {
    return 'Не удалось получить транскрипции для анализа. Попробуй снова или выбери другие ролики.';
  }

  const prompt = `Ты — эксперт по контент-маркетингу и анализу Instagram аккаунтов. 
Проанализируй аккаунт @${username} на основе транскрипций ${transcripts.length} Reels.

ТРАНСКРИПЦИИ:
${successfulTranscripts}

Дай ГЛУБОКИЙ анализ по следующим разделам:

1. ГОЛОС И СТИЛЬ АВТОРА
Как говорит автор? Какой у него тон, манера речи, характерные фразы и словечки?

2. ОСНОВНЫЕ ТЕМЫ И ЭКСПЕРТИЗА
О чём чаще всего говорит автор? В чём его главная экспертиза?

3. СТРУКТУРА КОНТЕНТА
Как автор строит свои видео? Типичный паттерн подачи информации?

4. ЧТО РАБОТАЕТ ЛУЧШЕ ВСЕГО
Какие типы роликов собирают больше лайков/просмотров? Почему?

5. АУДИТОРИЯ
Кто смотрит этот контент? К кому обращается автор?

6. TOF / MOF / BOF КОНТЕНТ
Разбивка: какой процент контента привлекает новых людей, прогревает, продаёт?

7. РЕКОМЕНДАЦИИ
5 конкретных рекомендаций по улучшению контент-стратегии

Пиши на русском языке. Будь конкретным, ссылайся на реальные фразы из транскрипций.`;

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
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude error: ${err}`);
  }

  const data = await response.json();
  return data.content?.[0]?.text || '(анализ недоступен)';
}
