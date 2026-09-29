# Seed data format

`ingredients.tsv` is the reviewable source; `ingredients.json` is generated from
it by `node seed/build-seed.mjs` and is what `scripts/bootstrap.ts` loads.

One line per ingredient beats 12,000 lines of JSON when the job is review: a
human can scan it, diff it, and sort it for duplicates. Nothing is hand-edited
in the JSON.

## Columns, pipe-separated

| # | Column             | Notes                                                        |
| - | ------------------ | ------------------------------------------------------------ |
| 1 | canonical_id       | snake_case, unique, stable. Never renamed once seeded.        |
| 2 | name               | display name                                                  |
| 3 | aliases            | comma-separated; Hindi and romanised names go here            |
| 4 | category           | one of the IngredientCategory enum in packages/shared         |
| 5 | default_unit       | one of the Unit enum; what to record when no unit is given    |
| 6 | default_shelf_days | integer, or blank for non-perishable                          |
| 7 | allergens          | comma-separated Allergen enum values, or blank                |
| 8 | diet_flags         | comma-separated IngredientFlag enum values, or blank          |
| 9 | confidence         | high / medium / low — drives REVIEW.md                        |
| 10 | review_note       | why it is not high confidence; blank when it is               |

`default_unit` answers "bought dhaniya" — a bunch — versus "bought milk" — a
litre. It is per ingredient rather than per category because a category default
cannot tell coriander from a carrot. A bare count still wins: "2 aloo" is two
pieces even though potato defaults to kg. `to_taste` is rejected by the
validator; it is a recipe amount, not something anyone buys.

`default_unit` is **not** covered by the confidence rating. A wrong unit is an
annoyance the user corrects in one tap; a wrong allergen is a safety bug.

Columns 9 and 10 are seed metadata. `build-seed.mjs` keeps them in the JSON for
the review workflow, and `bootstrap.ts` drops them before the D1 insert — the
`ingredients` table has no such columns.

## What confidence means

| Level  | Meaning                                                                 |
| ------ | ----------------------------------------------------------------------- |
| high   | Common ingredient, unambiguous allergens, shelf life well known.        |
| medium | Allergens are right but shelf life is a guess, or the name is regional. |
| low    | Composite or commercial product whose recipe varies by brand. Verify.   |

Allergen and flag errors are safety bugs. Shelf-day errors are annoyances.
When in doubt the entry is marked down, not up.
