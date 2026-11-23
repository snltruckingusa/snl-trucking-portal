// Safety training content, embedded in code (v1: one topic).
// Source of the wording: ~/workspace/safety-training/topic-01/ —
// script-and-slides.md, knowledge-checks.md, acknowledgment.md.
// The audio narration files live in the repo at
// public/audio/training/ (served by express.static in server.js),
// named screen-1.mp3 … screen-8.mp3 for topic-01.
//
// Check answers are verified BOTH in the player (for instant feedback
// and the try-again flow) and again on the server at completion time
// (routes/training.js calls checkAnswers) — a record is only marked
// completed when the server agrees every check is right.

const TOPICS = [
  {
    id: 'topic-01',
    title: 'Safety Begins at Home',
    subtitle: 'Topic 1 · It starts before you turn the key',
    audioBase: '/audio/training/',
    screens: [
      {
        headline: 'SAFETY BEGINS AT HOME',
        lines: [
          'Welcome to S&L Safety Training',
          'Topic 1: It starts before you turn the key',
        ],
        audio: 'screen-1.mp3',
        narration: "Welcome to S&L Trucking safety training. This is Topic One: Safety Begins at Home. Most safety talks start at the truck — the inspection, the road, the load. This one starts earlier. It starts at your house, before you ever turn the key. Because the way your day begins at home follows you into the cab. In the next few minutes, we will talk about your head, your rest, and your family — and why they matter more to your safety than anything on a checklist. Take your time. Listen to each screen, then tap next.",
      },
      {
        headline: 'A CLEAR HEAD DRIVES SAFE',
        lines: [
          'A peaceful home gives you a clear head',
          'A clear head keeps you safe',
        ],
        audio: 'screen-2.mp3',
        narration: "Here is the heart of it. A peaceful home gives you a clear head. And a clear head is what keeps you safe. Driving a loaded container truck takes full attention — mirrors, traffic, the weight behind you, the car that might cut in. If your mind is somewhere else, your eyes can be on the road and you still will not see what matters. You cannot park your thoughts in a lot and pick them up later. Whatever is on your mind rides with you. So we start the day settled — because a settled driver is a safe driver.",
      },
      {
        headline: "DON'T CARRY THE FIGHT",
        lines: [
          'Settle small things before you leave',
          'An argument in your head is a distraction on the road',
        ],
        audio: 'screen-3.mp3',
        narration: "Everybody has hard mornings. A bill, a worry, a disagreement with your wife or your kids. That is life, and nobody is asking you to be perfect. But settle the small things before you leave. Say the sorry. Make the quick call. Do not carry an argument onto the road. When you replay a fight in your head at sixty-five miles an hour, you are not really driving — the truck is just moving. If something big is on your mind and you cannot settle it, tell the company before you roll. A short talk now is always better than a long report later.",
      },
      {
        headline: 'YOUR FAMILY IS WAITING',
        lines: [
          'Finishing the day = coming home safe',
          'Not just finishing the load',
        ],
        audio: 'screen-4.mp3',
        narration: "Remember why the day ends. Your family is waiting for you. Finishing the day does not just mean finishing the load. It means coming home safe, walking through your own door, every single day. That is the real delivery. No container, no appointment, no schedule is worth more than that. When a moment on the road asks you to choose — hurry, or safe — picture who is waiting at home. That picture will make the right choice for you. Drive like somebody's whole world is in that cab. Because to your family, it is.",
      },
      {
        headline: 'REST IS SAFETY EQUIPMENT',
        lines: [
          'Sleep protects you like a seat belt does',
          'Tired? Stop somewhere safe and rest',
        ],
        audio: 'screen-5.mp3',
        narration: "You would never drive with bad brakes. So do not drive on bad rest. Sleep is safety equipment — just like your seat belt, just like your brakes. It works before anything goes wrong. Drowsy driving is as dangerous as drunk driving. Your eyes close for two seconds, and a loaded truck travels the length of a football field with nobody driving it. If you are fighting sleep, stop somewhere safe and rest. That is not weakness. That is professional. And know your hours: eleven hours of driving after ten hours off, inside a fourteen-hour window. Rest is part of the job — plan it like part of the job.",
      },
      {
        headline: 'STAY CALM. STAY PROFESSIONAL.',
        lines: [
          'Traffic and delays are part of this work',
          'Anger behind the wheel ends careers',
        ],
        audio: 'screen-6.mp3',
        narration: "Some days the road tests you. Traffic is stopped. The port is backed up. A car cuts you off and does not even look. Your blood pressure is your business — do not let a stranger set it. Stay calm. Traffic, waiting, and port delays are part of this work. They are not personal, and they are not worth your license, your job, or your life. Anger behind the wheel ends careers. Breathe. Slow down. Let the moment pass. The driver who stays calm is the driver who gets home — and the driver everybody at the port and the customer remembers as a professional.",
      },
      {
        headline: 'SPEAK UP EARLY',
        lines: [
          "A job that can't be done safely — say so",
          'That is what a professional does',
        ],
        audio: 'screen-7.mp3',
        narration: "Speaking up is part of safety, too. If a job cannot be done safely — or cannot be done legally inside your hours — say so, and say it early. That is not complaining. That is what a professional does. The schedule can change. Your log never should. Never edit your ELD records to make a load fit. Tell dispatch early, and the plan gets fixed on paper — not on the road, and not after something goes wrong. And look out for each other. If you see a risk to another driver, tell them. We are a small company. We watch each other's backs.",
      },
      {
        headline: 'HOME EVERY DAY',
        lines: [
          'The company schedules work so you get home daily',
          'Your part: a clear head and professional driving',
        ],
        audio: 'screen-8.mp3',
        narration: "We end with a promise — from the company to you. S&L schedules the work so you can get home every day. Home to your family, home to your own bed. That is how this company runs, and it is not changing. Your part is simple: bring a clear head, get your rest, stay calm, and speak up early. You are the face of S&L Trucking. At the port and at the customer, how you act is who we are. Take pride in it. Now complete the two short checks that follow, sign your name, and you are done. Thank you — and get home safe.",
      },
    ],
    match: {
      instruction: 'Tap a situation on the left, then tap what a professional does on the right. Match all 4 pairs.',
      left: [
        'An argument at home is still on your mind',
        'You are fighting sleep behind the wheel',
        'A load cannot be finished safely in your hours',
        'The port is backed up and you are stuck waiting',
      ],
      right: [
        'Stay calm — delays are part of the job',
        'Speak up to dispatch early — the schedule changes, not the log',
        "Settle it before you roll — don't carry it onto the road",
        'Stop somewhere safe and rest — sleep is safety equipment',
      ],
      // pairs[leftIndex] = rightIndex
      pairs: [2, 3, 1, 0],
      // why[leftIndex] = one-line explanation shown once the pair locks in
      why: [
        'A fight in your head is a distraction on the road.',
        'Drowsy driving is as dangerous as drunk driving. Rest first.',
        'Say it early. Never edit the ELD to make a load fit.',
        'Anger behind the wheel ends careers. Let the moment pass.',
      ],
    },
    mcq: [
      {
        q: 'What is the main idea of "Safety Begins at Home"?',
        options: [
          'Check your truck before every trip',
          'A calm, settled start at home gives you a clear head — and a clear head drives safe',
          'Always leave home one hour early',
          'Keep your phone off at home',
        ],
        correct: 1,
        why: 'The truck check matters, but this topic is about your mind: what is on your mind rides with you into the cab.',
      },
      {
        q: 'You argued with your family this morning, and your head is still in the fight as you start your shift. What should you do?',
        options: [
          'Drive anyway — the road will clear your head',
          'Call dispatch and quit for the day',
          'Take a few minutes to settle it — a quick call or a sorry — before you roll; if it is something big, tell the company before you start',
          'Turn the radio up loud so you stop thinking about it',
        ],
        correct: 2,
        why: 'Settle small things before you leave. Replaying a fight at highway speed means you are not really driving.',
      },
      {
        q: 'Dispatch gives you a load that cannot be finished safely and legally inside your hours. What is the professional move?',
        options: [
          'Run it and fix the log later',
          'Refuse and say nothing',
          'Drive faster to beat the clock',
          'Speak up early — tell dispatch so the schedule changes, not your safety and not your log',
        ],
        correct: 3,
        why: 'Speaking up early is what a professional does. The plan gets fixed on paper, never by editing the ELD.',
      },
    ],
    acknowledgment: 'I confirm that I listened to the Safety Training Topic 1: Safety Begins at Home, completed the knowledge checks, and understood the content — including settling things at home before I roll, treating rest as safety equipment, staying calm behind the wheel, and speaking up early when a job cannot be done safely or legally in my hours.',
  },
];

function getTopic(id) {
  return TOPICS.find((t) => t.id === id) || null;
}

// Step layout inside the player: screens 0..N-1, then the match check,
// then the MCQ check, then the sign screen. Steps are indexes into
// that sequence (used for resume).
function stepCount(topic) {
  return topic.screens.length + 3; // screens + match + mcq + sign
}

// Server-side verification of a submitted answers object.
// answers = { match: { "0": 2, "1": 3, ... }, mcq: [1, 2, 3] }
// Returns { ok: bool, failed: ['match'|'mcq', ...] }.
function checkAnswers(topic, answers) {
  const failed = [];
  const a = answers && typeof answers === 'object' ? answers : {};

  const m = a.match && typeof a.match === 'object' ? a.match : {};
  let matchOk = true;
  for (let i = 0; i < topic.match.pairs.length; i++) {
    if (Number(m[i]) !== topic.match.pairs[i]) { matchOk = false; break; }
  }
  if (!matchOk) failed.push('match');

  const q = Array.isArray(a.mcq) ? a.mcq : [];
  let mcqOk = q.length === topic.mcq.length;
  if (mcqOk) {
    for (let i = 0; i < topic.mcq.length; i++) {
      if (Number(q[i]) !== topic.mcq[i].correct) { mcqOk = false; break; }
    }
  }
  if (!mcqOk) failed.push('mcq');

  return { ok: failed.length === 0, failed };
}

module.exports = { TOPICS, getTopic, stepCount, checkAnswers };
