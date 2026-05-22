const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');

const app = express();
app.use(express.json({ limit: '10mb' }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || 'placeholder' });

// ─── TOOL 1: TAVILY SEARCH ───────────────────────────────────────────────────

async function tavilySearch(query, searchDepth = 'advanced') {
  try {
    const response = await axios.post('https://api.tavily.com/search', {
      api_key: process.env.TAVILY_API_KEY,
      query,
      search_depth: searchDepth,
      include_answer: true,
      include_raw_content: false,
      max_results: 5
    });
    return {
      answer: response.data.answer || '',
      results: response.data.results.map(r => ({
        title: r.title,
        url: r.url,
        content: r.content,
        score: r.score
      }))
    };
  } catch (e) {
    console.error('Tavily error:', e.message);
    return { answer: '', results: [] };
  }
}

// ─── TOOL 2: JINA AI READER ──────────────────────────────────────────────────

async function jinaRead(url) {
  try {
    const response = await axios.get(`https://r.jina.ai/${url}`, {
      headers: {
        'Accept': 'text/plain',
        'X-Return-Format': 'markdown'
      },
      timeout: 20000
    });
    return response.data.substring(0, 8000);
  } catch (e) {
    console.error('Jina error:', e.message);
    return '';
  }
}

// ─── TOOL 3: WIKIPEDIA ───────────────────────────────────────────────────────

async function wikipediaSearch(query) {
  try {
    const resp = await axios.get('https://en.wikipedia.org/w/api.php', {
      params: {
        action: 'query',
        list: 'search',
        srsearch: query,
        format: 'json',
        srlimit: 2
      }
    });
    const results = resp.data.query?.search || [];
    if (results.length === 0) return '';

    const pageResp = await axios.get('https://en.wikipedia.org/api/rest_v1/page/summary/' +
      encodeURIComponent(results[0].title));
    return pageResp.data.extract || '';
  } catch (e) {
    return '';
  }
}

// ─── RESEARCH PERSON ─────────────────────────────────────────────────────────

async function researchPerson(input) {
  console.log(`Researching person: ${input}`);

  const isUrl = input.startsWith('http');
  const isLinkedIn = isUrl && input.includes('linkedin.com');

  let jinaContent = '';
  let tavilyBio = { answer: '', results: [] };
  let tavilyCareer = { answer: '', results: [] };
  let wikipedia = '';
  let additionalContent = '';

  // Step 1: If LinkedIn URL — read directly with Jina
  if (isLinkedIn) {
    jinaContent = await jinaRead(input);
  }

  // Step 2: Tavily deep search for biography
  const bioQuery = isLinkedIn
    ? `${input} biography career education`
    : `"${input}" biography career education LinkedIn`;
  tavilyBio = await tavilySearch(bioQuery, 'advanced');

  // Step 3: Tavily search for career history
  const careerQuery = isLinkedIn
    ? `${input} work experience positions`
    : `"${input}" work experience career history`;
  tavilyCareer = await tavilySearch(careerQuery, 'basic');

  // Step 4: Jina reads top non-LinkedIn results
  for (const result of tavilyBio.results.slice(0, 2)) {
    if (!result.url.includes('linkedin.com')) {
      const content = await jinaRead(result.url);
      if (content) additionalContent += `\n[${result.url}]:\n${content.substring(0, 3000)}\n`;
    }
  }

  // Step 5: Wikipedia
  const personName = isLinkedIn
    ? input.split('/in/')[1]?.replace(/-/g, ' ') || input
    : input;
  wikipedia = await wikipediaSearch(personName);

  // Step 6: GPT-4o synthesizes all sources
  const prompt = `Ты исследователь, готовишь официальную справку о человеке для встречи с Министерством финансов Узбекистана.

INPUT: ${input}

Jina (LinkedIn/прямая страница):
${jinaContent || 'не найдено'}

Tavily (биография):
Ответ: ${tavilyBio.answer}
${tavilyBio.results.map(r => `${r.title}: ${r.content}`).join('\n')}

Tavily (карьера):
Ответ: ${tavilyCareer.answer}
${tavilyCareer.results.map(r => `${r.title}: ${r.content}`).join('\n')}

Jina (дополнительные источники):
${additionalContent || 'не найдено'}

Wikipedia:
${wikipedia || 'не найдено'}

Верни ТОЛЬКО валидный JSON без markdown:
{
  "full_name": "ФАМИЛИЯ Имя (транслитерация на русском)",
  "full_name_original": "Full Name in English",
  "position": "Текущая должность на русском",
  "company": "Название компании",
  "education": [
    {
      "years": "YYYY-YYYY гг.",
      "description": "Степень, специальность, Университет, Страна"
    }
  ],
  "career": [
    {
      "years": "YYYY-YYYY гг. или с YYYY года",
      "description": "Должность в «Компания»"
    }
  ],
  "confidence": "high/medium/low"
}

ПРАВИЛА:
- Все тексты на русском
- Имена: ФАМИЛИЯ Имя заглавными + транслитерация
- Названия компаний в «»
- Карьера от ранней к поздней
- confidence: high = нашел конкретные данные, low = пришлось предполагать`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.2,
    max_tokens: 2000
  });

  let response = completion.choices[0].message.content;
  response = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(response);
}

// ─── RESEARCH COMPANY ─────────────────────────────────────────────────────────

async function researchCompany(companyName, personName = '') {
  console.log(`Researching company: ${companyName}`);

  // Step 1: Tavily — company overview
  const companyOverview = await tavilySearch(
    `"${companyName}" company overview history financials headquarters`,
    'advanced'
  );

  // Step 2: Tavily — Uzbekistan connection
  const uzbekSearch = await tavilySearch(
    `"${companyName}" Uzbekistan OR Узбекистан investment cooperation agreement`,
    'advanced'
  );

  // Step 3: Wikipedia
  const wikipedia = await wikipediaSearch(companyName);

  // Step 4: Jina reads company website
  let websiteContent = '';
  const companyResult = companyOverview.results.find(r =>
    !r.url.includes('linkedin') &&
    !r.url.includes('wikipedia') &&
    !r.url.includes('bloomberg')
  );
  if (companyResult) {
    websiteContent = await jinaRead(companyResult.url);
  }

  // Step 5: GPT-4o synthesizes
  const prompt = `Ты эксперт по подготовке аналитических справок для государственных встреч Узбекистана.

Компания: ${companyName}
Связанный человек: ${personName}

Tavily (обзор):
Ответ: ${companyOverview.answer}
${companyOverview.results.map(r => `${r.title}: ${r.content}`).join('\n')}

Tavily (Узбекистан):
Ответ: ${uzbekSearch.answer}
${uzbekSearch.results.map(r => `${r.title}: ${r.content}`).join('\n')}

Wikipedia:
${wikipedia || 'не найдено'}

Jina (сайт компании):
${websiteContent ? websiteContent.substring(0, 3000) : 'не найдено'}

Верни ТОЛЬКО валидный JSON без markdown:
{
  "name": "Официальное название компании",
  "description": "3-4 абзаца на русском через \\n: деятельность, ключевые показатели, история, международное присутствие",
  "uzbekistan_connection": "Конкретные факты о связях с Узбекистаном. Если нет — потенциал сотрудничества",
  "activity_title": "ДЕЯТЕЛЬНОСТЬ «${companyName}» в Узбекистане",
  "activity_description": "2-3 абзаца через \\n о деятельности или потенциале сотрудничества по секторам",
  "confidence": "high/medium/low"
}`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.2,
    max_tokens: 2000
  });

  let response = completion.choices[0].message.content;
  response = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(response);
}

// ─── ENDPOINTS ────────────────────────────────────────────────────────────────

app.post('/research', async (req, res) => {
  try {
    const { input } = req.body;
    if (!input) return res.status(400).json({ error: 'input is required' });

    console.log(`Research request: "${input}"`);

    const personData = await researchPerson(input);
    const companyData = await researchCompany(
      personData.company,
      personData.full_name_original
    );

    return res.json({
      success: true,
      person: personData,
      company_info: companyData,
      education: personData.education || [],
      career: personData.career || []
    });

  } catch (error) {
    console.error('Research error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'research-api' }));

const PORT = process.env.RESEARCH_PORT || 3002;
app.listen(PORT, () => console.log(`Research API running on port ${PORT}`));
