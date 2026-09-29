/**
 * Section 5's context window, built for real rather than approximated, so the
 * token counts this spike measures are the ones production will pay for.
 *
 * | Slot    | Cap   |
 * | System  | 1,200 |
 * | Profile |   200 |
 * | Pantry  |   600 |
 * | Taste   |   300 |
 * | History | rest  |
 */

export const CHAT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

export const SYSTEM = `You are the kitchen agent for "We're So Cooked", a cooking assistant that manages one household's pantry, diet profile, weekly meal plans and grocery list.

Voice. Warm, dry, never twee. Short sentences. You are a competent friend who cooks, not a brand. Never use exclamation marks in a row, never call food "delicious" or "yummy", never say "I'd be happy to". If something is a bad idea, say so plainly and offer the better one.

Hard rules, in order of importance.
1. Safety is not yours to decide. Never claim a dish is vegan, gluten-free, nut-free or safe for any allergy. The safety engine tags every recipe before you see it; repeat its tags, never infer your own. If a user asks whether something is safe, tell them what the tags say and remind them to check labels.
2. Never invent pantry items. If you are unsure whether the user has something, call list_pantry or ask. Do not assume staples like salt, oil or onions are present.
3. Never write a recipe freehand. Always call suggest_recipes or substitute and present what comes back. If no tool result fits, say you could not find one rather than making a dish up.
4. Quantities come from the user or from a tool. If the user says "some dhaniya" you record an approximate quantity, not a precise one, and you say that you estimated it.
5. Expiry dates you did not read off a label are estimates. Say "about" when you quote one.
6. One tool per turn. If a request needs two actions, do the first and offer the second.
7. When a tool needs approval, explain what will change before the user approves it, in one sentence, with the exact items and amounts.

Tool guidance.
- add_pantry_items takes the user's raw phrase. Do not pre-parse it yourself; the tool normalizes names, quantities and units against the ingredient taxonomy and estimates expiry dates.
- log_cooked deducts a recipe's ingredients. It needs approval because a wrong deduction is tedious to undo. Show the deduction first.
- update_profile changes diets, allergens and exclusions. It is safety critical and always needs approval. Never infer a diet from one meal choice; a user ordering a vegan dish is not a vegan.
- suggest_recipes searches the catalog and may generate new options. Everything it returns has already passed the safety engine against the current profile.
- substitute takes one named dish and makes it fit the profile, listing every swap with a reason. Use it when the user names a dish and a constraint in the same breath.
- start_weekly_plan kicks off a background Workflow. It takes a few minutes. Tell the user you have started it and that they will get a message when it is ready; do not pretend to wait.
- remember_taste stores a like, a dislike or a note. Use it when the user reacts to food, not when they are making a request.

Presentation. Recipes, pantry lists and plans render as cards from tool output. Do not repeat a card's contents in prose. Add at most one line of context above a card, such as what you filtered for or why you picked it.

Budget. Every turn costs the user part of a daily allowance. Do not pad. Do not offer three options where one will do. Do not ask a clarifying question you could answer by calling list_pantry.`;

export const PROFILE_BLOCK = `Profile. Diets: vegetarian, no onion garlic (sattvic). Allergens: tree nuts, sesame. Custom exclusions: mushroom, raw tomato. Preferred cuisines: north indian, south indian, italian, japanese. Maximum cooking time: 40 minutes on weekdays. Servings: 3. Spice level: medium. Time zone: Asia/Kolkata.`;

/** Forty pantry rows in the shape the agent actually receives. */
const PANTRY_ROWS = [
  ['paneer', '400 g', 'expires in 2 days'],
  ['dahi', '500 g', 'expires in 3 days'],
  ['palak', '1 bunch', 'expires in 1 day'],
  ['dhaniya', '1 bunch', 'expires in 2 days'],
  ['methi', '1 bunch', 'expires in 3 days'],
  ['tomato', '6 pieces', 'expires in 5 days'],
  ['capsicum', '3 pieces', 'expires in 6 days'],
  ['gobhi', '1 piece', 'expires in 4 days'],
  ['baingan', '4 pieces', 'expires in 5 days'],
  ['lauki', '1 piece', 'expires in 6 days'],
  ['ginger', '80 g', 'expires in 14 days'],
  ['green chilli', '50 g', 'expires in 7 days'],
  ['lemon', '4 pieces', 'expires in 10 days'],
  ['curry leaves', '1 packet', 'expires in 5 days'],
  ['milk', '1 l', 'expires in 2 days'],
  ['butter', '200 g', 'expires in 30 days'],
  ['ghee', '500 g', 'expires in 180 days'],
  ['cheese', '200 g', 'expires in 20 days'],
  ['eggs', '6 pieces', 'expires in 12 days'],
  ['atta', '2 kg', 'expires in 60 days'],
  ['maida', '500 g', 'expires in 90 days'],
  ['besan', '500 g', 'expires in 90 days'],
  ['sooji', '500 g', 'expires in 90 days'],
  ['basmati rice', '2 kg', 'expires in 365 days'],
  ['poha', '500 g', 'expires in 120 days'],
  ['toor dal', '1 kg', 'expires in 180 days'],
  ['moong dal', '500 g', 'expires in 180 days'],
  ['chana dal', '500 g', 'expires in 180 days'],
  ['rajma', '500 g', 'expires in 180 days'],
  ['kabuli chana', '500 g', 'expires in 180 days'],
  ['spaghetti', '500 g', 'expires in 240 days'],
  ['passata', '1 packet', 'expires in 200 days'],
  ['olive oil', '500 ml', 'expires in 300 days'],
  ['mustard oil', '1 l', 'expires in 200 days'],
  ['jeera', '100 g', 'expires in 300 days'],
  ['haldi', '100 g', 'expires in 300 days'],
  ['garam masala', '80 g', 'expires in 200 days'],
  ['hing', '25 g', 'expires in 300 days'],
  ['rock salt', '500 g', 'expires in 700 days'],
  ['jaggery', '400 g', 'expires in 200 days'],
];

export const PANTRY_BLOCK = `Pantry. Expiring within 3 days: ${PANTRY_ROWS.filter((r) =>
  /in [123] day/.test(r[2] as string),
)
  .map((r) => `${r[0]} (${r[1]}, ${r[2]})`)
  .join('; ')}.
Everything else, by category: ${PANTRY_ROWS.map((r) => `${r[0]} ${r[1]}`).join(', ')}.
Total items: ${PANTRY_ROWS.length}.`;

export const TASTE_BLOCK = `Taste memory, most relevant first.
- dislike: "the last rajma was too spicy, go lighter on the mirchi" (weight 0.9)
- like: "loved the lemon rice, that tempering was perfect" (weight 0.8)
- note: "weeknights need to be under half an hour, weekends are fine" (weight 0.8)
- dislike: "not a fan of lauki unless it is in a kofta" (weight 0.6)
- like: "the baingan bharta was great even without onion" (weight 0.6)`;

export const HISTORY: { role: string; content: string }[] = [
  { role: 'user', content: 'bought 400g paneer and a bunch of palak today' },
  {
    role: 'assistant',
    content:
      'Added both. Paneer about 2 days, palak about 1 day — the palak is the one to use first.',
  },
  { role: 'user', content: 'what else is about to go off' },
  {
    role: 'assistant',
    content: 'Dahi and dhaniya in 2 to 3 days, milk in 2. Nothing else is urgent this week.',
  },
  { role: 'user', content: 'ok' },
];

export const USER_TURN = 'what can i make tonight, under 30 minutes, using the palak first';

/** The seven tools that matter for token cost; definitions count as input. */
export const TOOLS = [
  {
    name: 'add_pantry_items',
    description:
      'Add newly bought ingredients to the pantry. Takes the user raw phrase and normalizes names, quantities and units against the ingredient taxonomy, estimating an expiry date for each item.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The raw phrase describing what was bought.' } },
      required: ['text'],
    },
  },
  {
    name: 'list_pantry',
    description:
      'Read the pantry. Optionally restrict to items expiring within a number of days, or to one category.',
    parameters: {
      type: 'object',
      properties: {
        expiring_within_days: { type: 'number' },
        category: { type: 'string' },
      },
      required: [],
    },
  },
  {
    name: 'log_cooked',
    description:
      'Record that a dish was cooked and deduct its ingredients from the pantry. Needs approval: the deduction is shown to the user first.',
    parameters: {
      type: 'object',
      properties: { recipe_title: { type: 'string' }, servings: { type: 'number' } },
      required: ['recipe_title'],
    },
  },
  {
    name: 'update_profile',
    description:
      'Change diets, allergens or custom exclusions. Safety critical and always needs approval.',
    parameters: {
      type: 'object',
      properties: {
        diets: { type: 'array', items: { type: 'string' } },
        allergens: { type: 'array', items: { type: 'string' } },
        exclusions: { type: 'array', items: { type: 'string' } },
      },
      required: [],
    },
  },
  {
    name: 'suggest_recipes',
    description:
      'Search the recipe catalog and generate new options. Everything returned has already passed the safety engine against the current profile. Use for any "what can I make" request.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        max_minutes: { type: 'number' },
        use_first: { type: 'array', items: { type: 'string' }, description: 'Ingredient names to prioritise, usually the ones expiring soonest.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'substitute',
    description:
      'Rewrite one named dish so it fits the profile, listing every swap with a short explanation and any technique note.',
    parameters: {
      type: 'object',
      properties: { recipe_title: { type: 'string' }, constraint: { type: 'string' } },
      required: ['recipe_title'],
    },
  },
  {
    name: 'start_weekly_plan',
    description:
      'Start the weekly plan Workflow in the background. Returns immediately with a plan id.',
    parameters: {
      type: 'object',
      properties: {
        week_start: { type: 'string' },
        slots: { type: 'array', items: { type: 'string' } },
      },
      required: [],
    },
  },
];

export function chatMessages(): { role: string; content: string }[] {
  return [
    { role: 'system', content: SYSTEM },
    { role: 'system', content: PROFILE_BLOCK },
    { role: 'system', content: PANTRY_BLOCK },
    { role: 'system', content: TASTE_BLOCK },
    ...HISTORY,
    { role: 'user', content: USER_TURN },
  ];
}

/** Sixty catalog candidates, the retrieval budget from section 6. */
const DISHES = [
  'palak paneer', 'jeera aloo', 'lemon rice', 'curd rice', 'baingan bharta', 'methi thepla',
  'poha', 'upma', 'masala dosa', 'idli sambar', 'rajma chawal', 'chana masala', 'dal tadka',
  'kadhi chawal', 'paneer bhurji', 'vegetable pulao', 'gobhi paratha', 'aloo paratha',
  'besan chilla', 'moong dal khichdi', 'lauki kofta', 'bhindi masala', 'matar paneer',
  'malai kofta', 'shahi paneer', 'sambar', 'rasam', 'avial', 'pongal', 'uttapam',
  'pasta alla norma', 'cacio e pepe', 'pasta al pomodoro', 'risotto ai funghi',
  'margherita pizza', 'minestrone', 'caprese salad', 'gnocchi al burro', 'penne arrabbiata',
  'lasagne alle verdure', 'onigiri', 'miso soup', 'agedashi tofu', 'yasai itame',
  'tamagoyaki', 'zaru soba', 'kitsune udon', 'okonomiyaki', 'oyakodon', 'katsu curry',
  'shakshuka', 'falafel bowl', 'hummus and pita', 'tabbouleh', 'mujadara',
  'sheera', 'kheer', 'gajar halwa', 'besan ladoo', 'shrikhand',
];

export function planCandidates(): string {
  return DISHES.map((d, i) => {
    const minutes = 15 + ((i * 7) % 40);
    const tags = i % 3 === 0 ? 'vegetarian, sattvic' : i % 3 === 1 ? 'vegetarian' : 'vegan';
    return `- id=c${i + 1} | ${d} | ${minutes} min | tags: ${tags} | main ingredients: ${
      PANTRY_ROWS[(i * 3) % PANTRY_ROWS.length]?.[0]
    }, ${PANTRY_ROWS[(i * 5 + 2) % PANTRY_ROWS.length]?.[0]}, ${
      PANTRY_ROWS[(i * 11 + 5) % PANTRY_ROWS.length]?.[0]
    }`;
  }).join('\n');
}

export function planPrompt(days: string[]): string {
  return `Plan meals for these days: ${days.join(', ')}.

${PROFILE_BLOCK}

${PANTRY_BLOCK}

${TASTE_BLOCK}

Candidate recipes from the catalog:
${planCandidates()}

Rules. Every day needs breakfast, lunch, dinner and one sweet treat. Use items expiring soonest first. No dish repeats within seven days. Nothing over the profile's cooking time limit on weekdays. Prefer candidate ids; propose a new dish only when no candidate fits, and then give it a title and an ingredient list, no steps.

Answer as strict JSON and nothing else: {"days":[{"date":"YYYY-MM-DD","meals":[{"slot":"breakfast|lunch|dinner|treat","recipe_id":"c12 or null","title":"...","ingredients":["..."],"minutes":25}]}]}`;
}

export function repairPrompt(): string {
  return `Two days of the plan failed validation.

2026-09-24 dinner "malai kofta" uses cashew paste. The profile excludes tree nuts. Replace it.
2026-09-26 lunch "risotto ai funghi" uses mushroom, which is a custom exclusion. Replace it.

${PROFILE_BLOCK}

Candidate recipes from the catalog:
${planCandidates().split('\n').slice(0, 30).join('\n')}

Replace only those two meals. Answer as strict JSON and nothing else: {"fixes":[{"date":"YYYY-MM-DD","slot":"dinner","recipe_id":"c12 or null","title":"...","ingredients":["..."],"minutes":25}]}`;
}
