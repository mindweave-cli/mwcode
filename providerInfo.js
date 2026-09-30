// What the provider detail screen says about each provider, beyond what the engine
// knows. The models and prices are NOT here: they come from the engine's own rate
// tables (providerDetail), so the screen and the cost math can never disagree.
//
// Facts only, written the same way for every provider: who they are, where, how
// their billing works, and where to read more. Nothing that ranks or recommends one
// provider over another.
//
// pricesCheckedAt: when the engine's rates were last checked against the provider's
//   own pricing page.
// priceNotes: billing facts a reader would otherwise miss (peak hours, long-prompt
//   tiers, promotions and their end dates).
// modelNotes: a line under one model, keyed by model id.
// company: the company behind it, when that differs from the name in the list.
window.PROVIDER_INFO = {
  anthropic: {
    mark: 'A',
    tagline: 'AI research company · San Francisco, United States · Founded 2021',
    about:
      'Anthropic builds the Claude family of models. Through its API it offers several model lines: ' +
      'Opus and Fable for the hardest work, Sonnet as the general-purpose model, and Haiku for ' +
      'fast, low-cost tasks.',
    pricesCheckedAt: '2026-09-23',
    priceNotes: ['Cache write is the 5-minute cache rate, 1.25× input.'],
    links: [
      { label: 'Pricing', url: 'https://platform.claude.com/docs/en/about-claude/pricing' },
      { label: 'Models', url: 'https://platform.claude.com/docs/en/about-claude/models/overview' },
      { label: 'Console', url: 'https://console.anthropic.com' },
      { label: 'Website', url: 'https://www.anthropic.com' },
    ],
    trademark: 'Anthropic and Claude are trademarks of Anthropic, PBC.',
  },

  openai: {
    mark: 'O',
    tagline: 'AI research company · San Francisco, United States · Founded 2015',
    about:
      'OpenAI builds the GPT family of models. Its API offers the GPT-6 generation at three price ' +
      'points, Astra, Sol and Luna, alongside the earlier GPT-5.6 models.',
    pricesCheckedAt: '2026-09-23',
    priceNotes: ['Very long prompts are billed at a higher long-context rate, about double on input.'],
    links: [
      { label: 'Pricing', url: 'https://developers.openai.com/api/docs/pricing' },
      { label: 'Models', url: 'https://developers.openai.com/api/docs/models' },
      { label: 'Platform', url: 'https://platform.openai.com' },
      { label: 'Website', url: 'https://openai.com' },
    ],
    trademark: 'OpenAI and GPT are trademarks of OpenAI.',
  },

  gemini: {
    company: 'Google', // who bills you and holds the trademarks, where it isn't the provider's name
    mark: 'G',
    tagline: 'Google · Models by Google DeepMind · Mountain View, United States',
    about:
      'Gemini is Google\'s model family, built by Google DeepMind and offered to developers through ' +
      'the Gemini API and Google AI Studio. The lineup spans Pro for complex work, Flash as the ' +
      'general-purpose line, and Flash-Lite for high-volume, low-cost tasks.',
    pricesCheckedAt: '2026-09-23',
    priceNotes: [
      'Gemini 3.6, 3.7 and 3.8 Flash are at an introductory price through 31 December 2026; from 1 January 2027 each of their rates doubles.',
      'Gemini 3.1 Pro charges a higher rate for prompts over 200K tokens.',
    ],
    links: [
      { label: 'Pricing', url: 'https://ai.google.dev/gemini-api/docs/pricing' },
      { label: 'Models', url: 'https://ai.google.dev/gemini-api/docs/models' },
      { label: 'AI Studio', url: 'https://aistudio.google.com' },
    ],
    trademark: 'Google and Gemini are trademarks of Google LLC.',
  },

  xai: {
    mark: 'x',
    tagline: 'AI company · United States · Founded 2023',
    about:
      'xAI builds the Grok family of models and offers them through its own API. The models listed ' +
      'here all accept images and can reason before answering.',
    pricesCheckedAt: '2026-09-23',
    priceNotes: ['A request whose prompt reaches 200K tokens is billed at the higher long-context rate for all of its tokens.'],
    links: [
      { label: 'Models & pricing', url: 'https://docs.x.ai/developers/models' },
      { label: 'Console', url: 'https://console.x.ai' },
      { label: 'Website', url: 'https://x.ai' },
    ],
    trademark: 'xAI and Grok are trademarks of their respective owner.',
  },

  deepseek: {
    mark: 'D',
    tagline: 'AI research company · Hangzhou, China · Founded 2023',
    about:
      'DeepSeek develops the DeepSeek family of open-weight models and serves them through its own ' +
      'API. It offers two lines: V4 Pro for harder work and Flash for fast, low-cost tasks.',
    pricesCheckedAt: '2026-09-23',
    priceNotes: [
      'Prices shown are off-peak. During peak hours (01:00–04:00 and 06:00–10:00 UTC, Monday to Friday) every rate doubles.',
    ],
    links: [
      { label: 'Pricing', url: 'https://api-docs.deepseek.com/quick_start/pricing' },
      { label: 'Docs', url: 'https://api-docs.deepseek.com' },
      { label: 'Platform', url: 'https://platform.deepseek.com' },
      { label: 'Website', url: 'https://www.deepseek.com' },
    ],
    trademark: 'DeepSeek is a trademark of its respective owner.',
  },

  qwen: {
    company: 'Alibaba Cloud', // who bills you and holds the trademarks, where it isn't the provider's name
    mark: 'Q',
    tagline: 'Alibaba Cloud · Hangzhou, China',
    about:
      'Qwen is the model family built by Alibaba\'s Qwen team and offered through Alibaba Cloud Model ' +
      'Studio. The lineup has Max for the hardest work, Plus as the general-purpose model, and Flash ' +
      'for fast, low-cost tasks.',
    pricesCheckedAt: '2026-09-23',
    priceNotes: [
      'Prices are for the international (Singapore) endpoint.',
      'Qwen3.7 Plus includes a limited-time 20% discount on its list price of $0.40 / $1.60.',
      'Some models charge more for very long prompts.',
    ],
    links: [
      { label: 'Pricing', url: 'https://www.alibabacloud.com/help/en/model-studio/model-pricing' },
      { label: 'Models', url: 'https://www.alibabacloud.com/help/en/model-studio/models' },
      { label: 'Console', url: 'https://modelstudio.console.alibabacloud.com' },
      { label: 'Website', url: 'https://qwen.ai' },
    ],
    trademark: 'Qwen and Alibaba Cloud are trademarks of Alibaba Group.',
  },

  kimi: {
    company: 'Moonshot AI', // who bills you and holds the trademarks, where it isn't the provider's name
    mark: 'K',
    tagline: 'Moonshot AI · Beijing, China · Founded 2023',
    about:
      'Kimi is the model family built by Moonshot AI. Its API offers K3 as the flagship, K2.6 as a ' +
      'general model, and K2.7 Code for coding, with a faster, higher-priced HighSpeed version.',
    pricesCheckedAt: '2026-09-23',
    priceNotes: [],
    links: [
      { label: 'Pricing', url: 'https://platform.kimi.ai/docs/pricing/chat' },
      { label: 'Platform', url: 'https://platform.kimi.ai' },
      { label: 'Website', url: 'https://www.moonshot.ai' },
    ],
    trademark: 'Kimi and Moonshot AI are trademarks of their respective owner.',
  },

  glm: {
    company: 'Z.ai', // who bills you and holds the trademarks, where it isn't the provider's name
    mark: 'Z',
    tagline: 'Z.ai, formerly Zhipu AI · Beijing, China · Founded 2019',
    about:
      'Z.ai builds the GLM family of models. Its API offers the GLM-5 generation, with Flash and ' +
      'FlashX versions for faster, lower-cost work, and the earlier GLM-4.7 models.',
    pricesCheckedAt: '2026-09-23',
    priceNotes: [
      'Prices are for the international endpoint.',
      'Storing cached input is free for a limited time on the newer models.',
    ],
    links: [
      { label: 'Pricing', url: 'https://docs.z.ai/guides/overview/pricing' },
      { label: 'Docs', url: 'https://docs.z.ai' },
      { label: 'Website', url: 'https://z.ai' },
    ],
    trademark: 'GLM and Z.ai are trademarks of their respective owner.',
  },

  mistral: {
    company: 'Mistral AI', // who bills you and holds the trademarks, where it isn't the provider's name
    mark: 'M',
    tagline: 'AI company · Paris, France · Founded 2023',
    about:
      'Mistral AI builds open-weight and commercial models. Its API offers Medium and Large as the ' +
      'main models, Small for lighter work, and Ministral for small, low-cost tasks.',
    pricesCheckedAt: '2026-09-23',
    priceNotes: ['Cached input is billed at 90% off the input price.'],
    links: [
      { label: 'Pricing', url: 'https://mistral.ai/pricing/api/' },
      { label: 'Docs', url: 'https://docs.mistral.ai' },
      { label: 'Console', url: 'https://console.mistral.ai' },
      { label: 'Website', url: 'https://mistral.ai' },
    ],
    trademark: 'Mistral AI is a trademark of its respective owner.',
  },

  groq: {
    mark: 'g',
    tagline: 'AI inference company · Mountain View, United States · Founded 2016',
    about:
      'Groq runs open models from other labs on its own inference hardware, built for fast responses. ' +
      'The models it offers change over time, so the list is loaded from Groq once a key is connected.',
    pricesCheckedAt: '2026-09-23',
    priceNotes: ['Cached input is billed at half the input price.'],
    modelNotes: {
      'llama-3.3-70b-versatile':
        'Groq now offers this model to enterprise customers only, with no published price. The price shown is its last public rate.',
    },
    links: [
      { label: 'Models & pricing', url: 'https://console.groq.com/docs/models' },
      { label: 'Console', url: 'https://console.groq.com' },
      { label: 'Website', url: 'https://groq.com' },
    ],
    trademark: 'Groq is a trademark of Groq, Inc. Model names belong to the labs that made them.',
  },

  cerebras: {
    mark: 'C',
    tagline: 'AI hardware and inference company · Sunnyvale, United States · Founded 2015',
    about:
      'Cerebras runs open models from other labs on its own wafer-scale chips, built for very fast ' +
      'responses. The models it offers change over time, so the list is loaded from Cerebras once a ' +
      'key is connected.',
    pricesCheckedAt: '2026-09-23',
    priceNotes: ['Cached input is billed at the full input price: caching here speeds responses up but does not lower the bill.'],
    links: [
      { label: 'Pricing', url: 'https://www.cerebras.ai/pricing' },
      { label: 'Docs', url: 'https://inference-docs.cerebras.ai' },
      { label: 'Cloud', url: 'https://cloud.cerebras.ai' },
      { label: 'Website', url: 'https://www.cerebras.ai' },
    ],
    trademark: 'Cerebras is a trademark of Cerebras Systems Inc. Model names belong to the labs that made them.',
  },

  meta: {
    company: 'Meta', // who bills you and holds the trademarks, where it isn't the provider's name
    mark: 'M',
    tagline: 'Meta Platforms · Menlo Park, United States · Founded 2004',
    about:
      'Meta offers its Muse Spark models through the Meta Model API. Each model comes in two versions ' +
      'that differ in price and in how Meta may use your requests.',
    pricesCheckedAt: '2026-09-23',
    priceNotes: [
      'The Contributor versions are cheaper because Meta may use those requests to improve its products. Requests to the standard versions are not used that way.',
    ],
    links: [
      { label: 'Pricing', url: 'https://dev.meta.ai/products/meta-model-api/' },
      { label: 'Website', url: 'https://ai.meta.com' },
    ],
    trademark: 'Meta and Muse are trademarks of Meta Platforms, Inc.',
  },

  minimax: {
    mark: 'M',
    tagline: 'AI company · Shanghai, China · Founded 2021',
    about:
      'MiniMax builds text, speech and video models. Its API offers the MiniMax-M3 text model along ' +
      'with the earlier M2.7 and M2.',
    pricesCheckedAt: '2026-09-23',
    priceNotes: [
      'MiniMax-M3 is shown at its permanent 50% discount; prompts over 512K tokens cost double.',
    ],
    links: [
      { label: 'Pricing', url: 'https://platform.minimax.io/docs/guides/pricing-paygo' },
      { label: 'Platform', url: 'https://platform.minimax.io' },
      { label: 'Website', url: 'https://www.minimax.io' },
    ],
    trademark: 'MiniMax is a trademark of its respective owner.',
  },

  tencent: {
    company: 'Tencent Cloud', // who bills you and holds the trademarks, where it isn't the provider's name
    mark: 'T',
    tagline: 'Tencent Cloud · Shenzhen, China · Tencent founded 1998',
    about:
      'Tencent offers its Hunyuan Hy models through TokenHub on Tencent Cloud. Hy4 Preview ' +
      'is the newest model and Hy3 the lower-cost option.',
    pricesCheckedAt: '2026-09-23',
    priceNotes: [
      'Prices are for the international endpoint.',
      'Longer prompts may be billed at a higher tier.',
    ],
    links: [
      { label: 'TokenHub', url: 'https://www.tencentcloud.com/act/pro/tokenhub' },
      { label: 'Console', url: 'https://console.tencentcloud.com/tokenhub' },
    ],
    trademark: 'Tencent and Hy are trademarks of Tencent.',
  },

  openrouter: {
    mark: 'R',
    tagline: 'Model router · United States · Founded 2023',
    about:
      'OpenRouter gives one API and one key for hundreds of models from many providers. Its catalogue ' +
      'changes weekly, so the full list, with each model\'s current price, loads from OpenRouter once ' +
      'a key is connected.',
    pricesCheckedAt: null, // live from OpenRouter's catalogue, not a table in the engine
    priceNotes: [
      'Prices come live from OpenRouter\'s own catalogue and follow the rates of the provider serving each model.',
    ],
    links: [
      { label: 'Models & pricing', url: 'https://openrouter.ai/models' },
      { label: 'Docs', url: 'https://openrouter.ai/docs' },
      { label: 'Website', url: 'https://openrouter.ai' },
    ],
    trademark: 'OpenRouter is a trademark of its respective owner. Model names belong to the labs that made them.',
  },
};
