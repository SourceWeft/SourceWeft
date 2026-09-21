import type { SkillReviewSort } from "../../../../../lib/skill-reviews";

/**
 * English strings for ratings and reviews. Kept in one module so they can be
 * moved into the locale messages in one go.
 */
export const skillReviewsCopy = {
  heading: "Ratings and reviews",
  loading: "Loading reviews…",
  loadFailed: "Reviews could not be loaded.",
  retry: "Try again",
  noReviews: "No reviews yet.",
  averageLabel: (average: string) => `Average rating ${average} out of 5`,
  starsLabel: (rating: number) =>
    `${rating} ${rating === 1 ? "star" : "stars"}`,
  reviewCount: (count: number) =>
    `${count.toLocaleString("en")} ${count === 1 ? "review" : "reviews"}`,
  distributionLabel: (stars: number, count: number) =>
    `${stars} ${stars === 1 ? "star" : "stars"}: ${count.toLocaleString("en")}`,

  sortLabel: "Sort reviews",
  sorts: {
    newest: "Newest",
    highest: "Highest rated",
    lowest: "Lowest rated",
  } satisfies Record<SkillReviewSort, string>,
  loadMore: "Load more",

  anonymousReviewer: "Former user",
  version: (version: string) => `Version ${version}`,
  edited: "edited",
  authorReplyHeading: "Reply from the author",

  // The viewer's own review.
  yourReview: "Your review",
  writeReview: "Write a review",
  notInstalled: "Install the skill to review it.",
  hiddenNotice:
    "A moderator hid this review. Only you can see it, and it does not count toward the rating.",
  ratingPickerLabel: "Your rating",
  bodyLabel: "Review",
  bodyPlaceholder: "What worked, what didn’t, what you used it for…",
  charCount: (count: number, max: number) => `${count}/${max}`,
  save: "Save review",
  edit: "Edit",
  cancel: "Cancel",
  delete: "Delete",
  saved: "Review saved",
  deleted: "Review deleted",
  saveFailed: "The review could not be saved.",
  deleteFailed: "The review could not be deleted.",
  chooseRating: "Choose a rating first.",
  rateLimited:
    "You have changed reviews too often. Try again in a little while.",

  // The repository author's reply.
  reply: "Reply",
  editReply: "Edit reply",
  deleteReply: "Delete reply",
  replyLabel: "Your reply",
  saveReply: "Save reply",
  replySaved: "Reply saved",
  replyDeleted: "Reply deleted",
  replyFailed: "The reply could not be saved.",

  // Market admin moderation.
  hide: "Hide",
  show: "Show",
  hiddenBadge: "Hidden",
  hiddenToast: "Review hidden",
  shownToast: "Review shown",
  moderateFailed: "The review could not be updated.",
};

export type SkillReviewsCopy = typeof skillReviewsCopy;
