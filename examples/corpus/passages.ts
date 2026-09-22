export type ExamplePassage = {
  readonly id: string;
  readonly title: string;
  readonly text: string;
};

export const passages: readonly ExamplePassage[] = [
  {
    id: "apollo-11",
    title: "Apollo 11",
    text: 'Apollo 11 (July 16–24, 1969) was the American spaceflight that first landed humans on the Moon, and the fifth crewed mission of NASA\'s Apollo program. The mission was crewed by Commander Neil Armstrong, Command Module Pilot Michael Collins, and Lunar Module Pilot Edwin "Buzz" Aldrin, all of whom were on their second and final spaceflight.',
  },
  {
    id: "monaco-1992",
    title: "1992 Monaco Grand Prix",
    text: "The 78-lap race was won by Ayrton Senna, driving a McLaren-Honda. Drivers' Championship leader Nigel Mansell took pole position in his Williams-Renault and led until lap 71, when he suspected he had a puncture and made a pit stop for new tyres. He emerged behind Senna, closed up to the Brazilian and tried to find a way past but without success, Senna holding on to win by 0.2 seconds. It was Senna's fifth Monaco Grand Prix win, equalling the record set by Graham Hill.",
  },
  {
    id: "marge-vs-the-monorail",
    title: "Marge vs. the Monorail",
    text: "When the Environmental Protection Agency fines Mr. Burns $3 million for dumping nuclear waste in a Springfield park, a town meeting is held to decide how to spend the money. Marge nearly persuades the townspeople to repair Springfield's heavily damaged Main Street, but fast-talking salesman Lyle Lanley leads a song-and-dance routine that convinces them to build a monorail.",
  },
];
