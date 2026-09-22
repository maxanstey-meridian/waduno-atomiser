const race = {
  title: "1992 Monaco Grand Prix",
  text: "The 78-lap race was won by Ayrton Senna, driving a McLaren-Honda. Drivers' Championship leader Nigel Mansell took pole position in his Williams-Renault and led until lap 71, when he suspected he had a puncture and made a pit stop for new tyres. He emerged behind Senna, closed up to the Brazilian and tried to find a way past but without success, Senna holding on to win by 0.2 seconds. It was Senna's fifth Monaco Grand Prix win, equalling the record set by Graham Hill.",
};

export const contextCanaries = [
  {
    name: "championship scope missing",
    source: race,
    claim: "Nigel Mansell is the Drivers' Championship leader.",
    expected: false,
  },
  {
    name: "championship scope explicit",
    source: race,
    claim: "Nigel Mansell was the Drivers' Championship leader at the 1992 Monaco Grand Prix.",
    expected: true,
  },
  {
    name: "record unidentified",
    source: race,
    claim: "Ayrton Senna equaled the record set by Graham Hill.",
    expected: false,
  },
  {
    name: "record identified",
    source: race,
    claim:
      "At the 1992 Monaco Grand Prix, Ayrton Senna equalled Graham Hill's record of five Monaco Grand Prix wins.",
    expected: true,
  },
  {
    name: "winning margin without event",
    source: race,
    claim: "Ayrton Senna held on to win by 0.2 seconds.",
    expected: false,
  },
  {
    name: "winning margin with event",
    source: race,
    claim: "Ayrton Senna won the 1992 Monaco Grand Prix by 0.2 seconds.",
    expected: true,
  },
  {
    name: "overtaking target missing",
    source: race,
    claim: "Nigel Mansell tried to find a way past.",
    expected: false,
  },
  {
    name: "overtaking target and event explicit",
    source: race,
    claim: "Nigel Mansell tried to pass Ayrton Senna at the 1992 Monaco Grand Prix.",
    expected: true,
  },
  {
    name: "concrete object needs no unique identity",
    source: { title: "", text: "Cartman decides to hide the key. He does just that." },
    claim: "Cartman hides the key.",
    expected: true,
  },
  {
    name: "unresolved action",
    source: { title: "", text: "Cartman decides to hide the key. He does just that." },
    claim: "He does just that.",
    expected: false,
  },
];
