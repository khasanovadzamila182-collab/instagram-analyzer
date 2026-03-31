// api/get-reels.js
// Загружает список Reels аккаунта через Apify Instagram Scraper
// ENV: APIFY_TOKEN

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { username, limit = 20 } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });

  const APIFY_TOKEN = process.env.APIFY_TOKEN;
  if (!APIFY_TOKEN) return res.status(500).json({ error: 'APIFY_TOKEN не настроен' });

  try {
    // Запускаем Apify actor для получения Reels
    // Actor: apify/instagram-reel-scraper
    const startRes = await fetch(
      `https://api.apify.com/v2/acts/apify~instagram-scraper/runs?token=${APIFY_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          directUrls: [`https://www.instagram.com/${username}/`],
          resultsType: 'posts',
          resultsLimit: limit,
          addParentData: false,
        }),
      }
    );

    if (!startRes.ok) {
      const err = await startRes.text();
      throw new Error(`Apify start failed: ${err}`);
    }

    const startData = await startRes.json();
    const runId = startData.data.id;
    const datasetId = startData.data.defaultDatasetId;

    // Ждём завершения Apify run (max 3 мин)
    let status = 'RUNNING';
    let attempts = 0;
    while (status === 'RUNNING' || status === 'READY' || status === 'ABORTING') {
      if (attempts++ > 36) throw new Error('Apify timeout — попробуй ещё раз');
      await sleep(5000);
      const statusRes = await fetch(`https://api.apify.com/v2/acts/apify~instagram-scraper/runs/${runId}?token=${APIFY_TOKEN}`);
      const statusData = await statusRes.json();
      status = statusData.data.status;
    }

    if (status !== 'SUCCEEDED') throw new Error(`Apify завершился со статусом: ${status}`);

    // Получаем результаты
    const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&limit=${limit}`);
    const items = await itemsRes.json();

    if (!items || items.length === 0) {
      return res.status(200).json({ reels: [], message: 'Роликов не найдено. Возможно, аккаунт закрытый.' });
    }

    // Нормализуем данные
    const reels = items.map(item => ({
      id: item.id || item.shortCode,
      shortCode: item.shortCode,
      videoUrl: item.videoUrl,
      displayUrl: item.displayUrl,
      caption: item.caption || '',
      likesCount: item.likesCount || 0,
      commentsCount: item.commentsCount || 0,
      videoViewCount: item.videoViewCount || 0,
      timestamp: item.timestamp,
      type: item.type,
    }));

    return res.status(200).json({ reels, username });

  } catch (error) {
    console.error('get-reels error:', error);
    return res.status(500).json({ error: error.message });
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
