// Built-in prompt deck. Good prompts have one obvious answer that most people
// reach for, plus a few tempting alternatives.
export const DECKS = {
  classic: [
    'A fruit', 'A colour', 'A pizza topping', 'A breakfast cereal', 'A farm animal',
    'A day of the week', 'A month of the year', 'A number between 1 and 10',
    'A planet', 'A shape', 'A musical instrument', 'A sport played with a ball',
    'A vegetable', 'A flavour of ice cream', 'A type of tree', 'A body of water',
    'Something in a toolbox', 'Something you find at the beach', 'A board game',
    'A card game', 'A type of dog', 'A wild animal', 'A bird', 'A sea creature',
    'An insect', 'A season', 'A type of weather', 'A kitchen appliance',
    'Something in a bathroom', 'A school subject', 'A job', 'A superpower',
    'A type of cheese', 'A sandwich filling', 'A breakfast food', 'A dessert',
    'A soft drink', 'A hot drink', 'A type of pasta', 'A nut', 'A spice',
    'A herb', 'A type of bread', 'A Christmas thing', 'A Halloween costume',
    'A birthday thing', 'A piece of furniture', 'A room in a house',
    'Something with wheels', 'A mode of transport', 'A car brand', 'A metal',
    'A gemstone', 'A flower', 'A type of shoe', 'An item of clothing',
    'Something you wear on your head', 'A dance', 'A martial art', 'A language',
    'A letter of the alphabet', 'A vowel', 'A Greek letter', 'A chess piece',
    'A zodiac sign', 'A body part', 'An organ in the body', 'A bone',
    'Something cold', 'Something hot', 'Something sticky', 'Something round',
    'Something yellow', 'Something red', 'Something green', 'Something soft',
    'Something that smells bad', 'Something that is loud', 'Something you plug in',
    'Something in a fridge', 'Something in a pencil case', 'Something in a handbag',
  ],
  places: [
    'A country in Europe', 'A country in Asia', 'A country in Africa',
    'A capital city', 'A US state', 'An Australian city', 'An Australian state',
    'A famous landmark', 'A continent', 'An ocean', 'A river', 'A mountain',
    'A holiday destination', 'A theme park', 'A shop at the shopping centre',
    'A fast food chain', 'A supermarket', 'Somewhere you go on a first date',
    'An island', 'A city that starts with S', 'A desert', 'A Queensland town',
  ],
  pop: [
    'A Disney film', 'A superhero', 'A cartoon character', 'A Beatle',
    'A famous wizard', 'A streaming service', 'A social media app',
    'A video game console', 'A video game', 'A boy band', 'A famous painter',
    'A Shakespeare play', 'A Christmas song', 'A famous scientist',
    'A famous Australian', 'A James Bond actor', 'A fairy tale',
    'A nursery rhyme', 'A Harry Potter character', 'A Star Wars character',
    'A Pixar film', 'A sitcom', 'A reality TV show', 'A famous Taylor',
    'A famous Chris', 'A fictional detective', 'A movie villain',
    'A Muppet', 'A Simpsons character', 'A pop star', 'A rapper',
    'A tech company', 'A clothing brand', 'A chocolate bar', 'A brand of chips',
  ],
  aussie: [
    'An Aussie animal', 'An Aussie snack', 'A thing at a Bunnings sausage sizzle',
    'An Aussie slang word', 'A Brisbane suburb', 'A beach in Australia',
    'An NRL team', 'An AFL team', 'A Bluey character', 'A Tim Tam flavour',
    'Something on a barbie', 'Something in an Esky', 'A dangerous Aussie creature',
    'An Aussie band', 'An Aussie biscuit', 'Something you take camping',
    'A Gold Coast theme park', 'A thing at the Ekka', 'A type of meat pie',
  ],
  spicy: [
    'The best pizza topping', 'The worst pizza topping', 'The best day of the week',
    'The worst chore', 'The best decade for music', 'The most annoying sound',
    'A dealbreaker on a date', 'Something you should never say at a wedding',
    'The best age to be', 'The best fast food', 'The most overrated food',
    'Something you would take to a desert island', 'The best superpower',
    'The scariest animal', 'The cutest animal', 'The best smell',
    'The worst smell', 'The best holiday', 'Something you do when no one is watching',
    'The first thing you do in the morning', 'A thing people lie about',
    'The best way to eat a potato', 'The most useless invention',
    'A guilty pleasure', 'The best Friends character', 'A word that sounds rude but is not',
    'Something you shout at the TV', 'The best excuse for being late',
    'What you would name a pet goldfish', 'Something your nan says',
  ],
};

export const DECK_NAMES = {
  classic: 'Classic', places: 'Places', pop: 'Pop culture', aussie: 'Aussie', spicy: 'Opinions',
};

export function randomCategory(deckKeys, used = []) {
  const keys = (deckKeys && deckKeys.length ? deckKeys : Object.keys(DECKS)).filter(k => DECKS[k]);
  const pool = keys.flatMap(k => DECKS[k]);
  const usedSet = new Set(used);
  const fresh = pool.filter(c => !usedSet.has(c));
  const from = fresh.length ? fresh : pool;
  return from[Math.floor(Math.random() * from.length)];
}
