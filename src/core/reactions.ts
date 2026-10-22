// GitHub's eight comment reactions, in the order github.com offers them.
export const REACTIONS = {
  THUMBS_UP: '👍',
  THUMBS_DOWN: '👎',
  LAUGH: '😄',
  HOORAY: '🎉',
  CONFUSED: '😕',
  HEART: '❤️',
  ROCKET: '🚀',
  EYES: '👀',
} as const;

export type ReactionContent = keyof typeof REACTIONS;

export const REACTION_NAMES: Record<ReactionContent, string> = {
  THUMBS_UP: 'Thumbs up',
  THUMBS_DOWN: 'Thumbs down',
  LAUGH: 'Laugh',
  HOORAY: 'Hooray',
  CONFUSED: 'Confused',
  HEART: 'Heart',
  ROCKET: 'Rocket',
  EYES: 'Eyes',
};

/** "👍 Thumbs up": how VS Code's reaction menu lists a reaction. */
export function reactionLabel(content: ReactionContent): string {
  return `${REACTIONS[content]} ${REACTION_NAMES[content]}`;
}
