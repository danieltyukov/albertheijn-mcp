import { describe, expect, it } from 'vitest';
import { extractRecipe, isoMinutes, parseServings } from '../src/recipes/web-recipe.js';
import { readableText } from '../src/web/html.js';

const page = `<!doctype html><html><head><title>Pasta pesto | Example Kitchen</title>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
 {"@type":"WebSite","name":"Example Kitchen"},
 {"@type":["Recipe"],"name":"Pasta pesto met kip","description":"Snel &amp; makkelijk.",
  "recipeYield":["4","4 personen"],"totalTime":"PT25M","prepTime":"PT10M","cookTime":"PT15M",
  "recipeIngredient":["300 g penne","250 g kipfilet","1 potje groene pesto (190 g)","2 el olijfolie"],
  "recipeInstructions":[{"@type":"HowToSection","name":"Voorbereiding","itemListElement":[{"@type":"HowToStep","text":"Kook de pasta."}]},{"@type":"HowToStep","text":"Bak de kip &lt;b&gt;goudbruin&lt;/b&gt;."}],
  "recipeCategory":"Hoofdgerecht","recipeCuisine":"Italiaans","keywords":"pasta, kip, snel",
  "nutrition":{"@type":"NutritionInformation","calories":"640 kcal","proteinContent":"38 g"},
  "image":{"@type":"ImageObject","url":"https://example.com/p.jpg"},"author":{"@type":"Person","name":"Sam"}}
]}</script></head><body><nav>menu</nav><main><h1>Pasta pesto</h1><p>Lekker &amp; snel.</p></main></body></html>`;

describe('extractRecipe', () => {
  it('reads a schema.org recipe from a JSON-LD graph', () => {
    const recipe = extractRecipe(page, 'https://example.com/pasta');
    expect(recipe).toBeDefined();
    expect(recipe!.name).toBe('Pasta pesto met kip');
    expect(recipe!.servings).toBe(4);
    expect(recipe!.ingredients).toHaveLength(4);
    expect(recipe!.instructions).toEqual(['Voorbereiding:', 'Kook de pasta.', 'Bak de kip goudbruin .']);
    expect(recipe!.totalMinutes).toBe(25);
    expect(recipe!.category).toEqual(['Hoofdgerecht']);
    expect(recipe!.keywords).toEqual(['pasta', 'kip', 'snel']);
    expect(recipe!.nutrition).toEqual({ calories: '640 kcal', proteinContent: '38 g' });
    expect(recipe!.image).toBe('https://example.com/p.jpg');
    expect(recipe!.author).toBe('Sam');
    expect(recipe!.description).toBe('Snel & makkelijk.');
  });

  it('returns undefined when there is no recipe', () => {
    expect(extractRecipe('<html><body>hi</body></html>', 'https://x.test')).toBeUndefined();
  });
});

describe('helpers', () => {
  it('parses ISO durations', () => {
    expect(isoMinutes('PT1H30M')).toBe(90);
    expect(isoMinutes('P0DT45M')).toBe(45);
    expect(isoMinutes('nonsense')).toBeUndefined();
  });

  it('parses servings', () => {
    expect(parseServings('6 porties')).toEqual({ servings: 6, yieldText: '6 porties' });
    expect(parseServings(2)).toEqual({ servings: 2, yieldText: '2' });
  });

  it('keeps the main text and drops navigation', () => {
    expect(readableText(page)).toBe('Pasta pesto\nLekker & snel.');
  });
});
