const db = require('./db');

const MENU = {
  "Starters": [
    { id: 's1', name: 'Ridgeline Nachos', desc: 'House chips, black bean chili, cheddar, pickled jalapeño', price: 295, thumb: '#f0e6d2', emoji: '🧀' },
    { id: 's2', name: 'Trailhead Wings', desc: 'Smoked paprika dry rub, blue cheese dip', price: 345, thumb: '#f5ddd2', emoji: '🍗' },
    { id: 's3', name: 'Charred Corn Elote', desc: 'Cotija, lime crema, chili powder', price: 185, thumb: '#fdeec2', emoji: '🌽' },
  ],
  "Mains": [
    { id: 'm1', name: 'Mountain Ridge Burger', desc: 'Angus beef, smoked gouda, caramelized onion, brioche', price: 450, thumb: '#f0d9c5', emoji: '🍔' },
    { id: 'm2', name: 'Wood-Fired Trout', desc: 'Local trout, herb butter, roasted seasonal veg', price: 620, thumb: '#dce9dd', emoji: '🐟' },
    { id: 'm3', name: 'Alpine Grain Bowl', desc: 'Farro, roasted squash, kale, tahini dressing', price: 395, thumb: '#e4ecd9', emoji: '🥗' },
    { id: 'm4', name: 'Terrace Wood-Fired Pizza', desc: 'San marzano, fresh mozzarella, basil', price: 425, thumb: '#f5e0c8', emoji: '🍕' },
  ],
  "Drinks": [
    { id: 'd1', name: 'Cold Brew Tonic', desc: 'House cold brew, citrus tonic', price: 165, thumb: '#e8dccb', emoji: '🥤' },
    { id: 'd2', name: 'Valley Pale Ale', desc: 'Local brewery, on tap', price: 195, thumb: '#f2e3bd', emoji: '🍺' },
    { id: 'd3', name: 'Sunset Paloma', desc: 'Tequila, grapefruit, soda, lime', price: 285, thumb: '#f6d9c9', emoji: '🍹' },
  ],
  "Desserts": [
    { id: 'de1', name: "Campfire S'mores Tart", desc: 'Torched marshmallow, dark chocolate ganache', price: 225, thumb: '#e6d3c0', emoji: '🍫' },
    { id: 'de2', name: 'Huckleberry Crumble', desc: 'Wild huckleberry, oat crumble, vanilla bean ice cream', price: 245, thumb: '#e3d0dc', emoji: '🫐' },
  ]
};

const COURTS = ['Court 1', 'Court 2', 'Court 3', 'Court 4'];

function seed() {
  /* Once the menu is editable from the staff board, this script must never
     overwrite what Rey has set. It fills an empty database and otherwise
     steps aside — which also makes it safe to run on every container start.
     Pass --force to deliberately reset back to these starting values. */
  const force = process.argv.includes('--force');
  const existing = db.prepare('SELECT COUNT(*) c FROM menu_items').get().c;

  if (existing > 0 && !force) {
    console.log(`Menu already set up (${existing} items) — leaving it alone.`);
    console.log('Run `npm run seed -- --force` to reset to the starting menu.');
    return;
  }
  if (force && existing > 0) {
    console.log(`Resetting ${existing} menu items back to the starting menu…`);
  }

  const insertMenu = db.prepare(`
    INSERT INTO menu_items (id, category, name, description, price, emoji, thumb, sort_order)
    VALUES (@id, @category, @name, @description, @price, @emoji, @thumb, @sort_order)
    ON CONFLICT(id) DO UPDATE SET
      category=excluded.category, name=excluded.name, description=excluded.description,
      price=excluded.price, emoji=excluded.emoji, thumb=excluded.thumb, sort_order=excluded.sort_order
  `);
  const insertCourt = db.prepare(`
    INSERT INTO courts (id, name, sort_order) VALUES (@id, @name, @sort_order)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, sort_order=excluded.sort_order
  `);

  const tx = db.transaction(() => {
    let catOrder = 0;
    for (const category of Object.keys(MENU)) {
      let itemOrder = 0;
      for (const item of MENU[category]) {
        insertMenu.run({
          id: item.id,
          category,
          name: item.name,
          description: item.desc,
          price: item.price,
          emoji: item.emoji,
          thumb: item.thumb,
          sort_order: catOrder * 100 + itemOrder
        });
        itemOrder++;
      }
      catOrder++;
    }
    COURTS.forEach((name, i) => {
      insertCourt.run({ id: 'court-' + (i + 1), name, sort_order: i });
    });
  });
  tx();
  console.log('Seed complete:', db.prepare('SELECT COUNT(*) c FROM menu_items').get().c, 'menu items,',
    db.prepare('SELECT COUNT(*) c FROM courts').get().c, 'courts');
}

seed();
