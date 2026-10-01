/**
 * Which tools a turn is offered, from what the user said.
 *
 * All fifteen tool definitions are about 3,000 tokens, sent with every model
 * call — more than the system prompt and the pantry together, and most of a
 * turn's cost at Llama 3.3's input rate. A message about the pantry needs the
 * four pantry tools, not the weekly planner.
 *
 * So a message picks groups by its words, and the pantry tools always come
 * along, because nearly anything can touch the pantry ("made dal" deducts
 * it). A message that matches no group gets every tool: an unrecognised
 * request costs what it always did, it never loses the tool it needed.
 */

/**
 * Always offered. The pantry is the thing every flow reads or writes. And
 * update_profile is how an allergy gets saved: a missed keyword must never
 * leave "i can't have gluten" with no way to record it, so it is not left
 * to the word lists below.
 */
const CORE = [
  'add_pantry_items',
  'list_pantry',
  'update_pantry_item',
  'remove_pantry_items',
  'update_profile',
];

const GROUPS: { words: RegExp; tools: string[] }[] = [
  {
    // Food ideas, and the follow-ups that come with them.
    words:
      /\b(make|cook|cooking|recipes?|suggest\w*|ideas?|dinner|lunch|breakfast|snack|eat|tonight|today|meals?|hungry|khana|dish(es)?|swap|substitute|instead|vegan|vegetarian|veg|trending|viral)\b/i,
    // get_plan too: "what's for dinner tomorrow" may already be planned.
    tools: ['suggest_recipes', 'substitute', 'search_trending', 'remember_taste', 'get_plan'],
  },
  {
    // Something was cooked or eaten, which deducts the pantry.
    words: /\b(made|cooked|ate|had|finished)\b/i,
    tools: ['log_cooked'],
  },
  {
    // Who they are: diets, allergies, preferences.
    words:
      /\b(i'?m|i am|allerg\w*|intoleran\w*|gluten|lactose|dairy|nuts?|peanuts?|celiac|coeliac|avoid|vegan|vegetarian|veg|jain|halal|diet|spic\w*|servings?|people|profile|don'?t|can'?t|cannot|hate|love|like|dislike)\b/i,
    tools: ['remember_taste'],
  },
  {
    // The week and the shop.
    words: /\b(plan|week|weekly|grocer\w*|shopping|list|buy|bought it|tick|checked?)\b/i,
    tools: ['start_weekly_plan', 'get_plan', 'get_grocery_list', 'check_grocery_item'],
  },
  {
    words: /\b(undo|restore|put back|bring back|by mistake|accident\w*)\b/i,
    tools: ['restore_pantry_items'],
  },
];

/** The tool names to offer, or null for all of them. */
export function toolsFor(rawText: string): string[] | null {
  // Phones type a curly apostrophe; "don’t" should read as "don't".
  const userText = rawText.replace(/[\u2018\u2019]/g, "'");
  const picked = new Set<string>();
  for (const group of GROUPS) {
    if (group.words.test(userText)) for (const t of group.tools) picked.add(t);
  }
  // "bought 1kg paneer" matches nothing above and needs only the core; a
  // message that is clearly about the pantry should not pay for everything.
  const aboutPantry = /\b(bought|got|have|added?|remove|throw|threw|expired?|fridge|pantry|left)\b/i;
  if (picked.size === 0 && !aboutPantry.test(userText)) return null;
  return [...CORE, ...picked];
}
