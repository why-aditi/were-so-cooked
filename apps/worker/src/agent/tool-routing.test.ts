import { describe, expect, it } from 'vitest';
import { toolsFor } from './tool-routing.js';

describe('toolsFor', () => {
  it('gives a pantry message only the pantry tools', () => {
    expect(toolsFor('bought 1kg paneer, 6 eggs')).toEqual([
      'add_pantry_items',
      'list_pantry',
      'update_pantry_item',
      'remove_pantry_items',
    ]);
  });

  it('adds the food tools when they ask for food', () => {
    const tools = toolsFor('what can i make tonight');
    expect(tools).toContain('suggest_recipes');
    expect(tools).not.toContain('start_weekly_plan');
  });

  it('routes a diet statement to the profile and to fresh ideas', () => {
    const tools = toolsFor('but im vegetarian');
    expect(tools).toContain('update_profile');
    expect(tools).toContain('suggest_recipes');
  });

  it('routes cooking something to log_cooked', () => {
    expect(toolsFor('made palak paneer')).toContain('log_cooked');
  });

  it('routes the week and the shop to the planner', () => {
    expect(toolsFor('plan my week')).toContain('start_weekly_plan');
    expect(toolsFor("what's on my grocery list")).toContain('get_grocery_list');
  });

  it('offers everything when it cannot tell', () => {
    expect(toolsFor('hey')).toBeNull();
    expect(toolsFor('hmm')).toBeNull();
  });
});
