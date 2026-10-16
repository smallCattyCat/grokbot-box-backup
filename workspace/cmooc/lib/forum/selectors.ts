import type { ForumSettingsInput } from "@/lib/settings";

export const forumSelectors = {
  mock: {
    postTitle: '[data-testid="post-title"]',
    postContent: '[data-testid="post-content"]',
    replyEditor: '[data-testid="reply-editor"]',
    replySubmit: '[data-testid="reply-submit"]',
    replySuccess: '[data-testid="reply-success"]'
  },
  real: {
    loginMarker: "",
    postCommentEditor: ".comment_container #edit .ql-editor",
    postCommentSubmit: ".comment_container .buttons .right",
    commentItem: ".comment .items > .cComment.item",
    commentReplyButton: ".buttons .right .reply",
    nestedReplyEditorScoped: ":scope > div > .reply #edit .ql-editor",
    nestedReplyEditorFallback: ".reply #edit .ql-editor",
    nestedReplySubmitScoped: ":scope > div > .reply > .buttons .right",
    nestedReplySubmitFallback: ".reply .buttons .right",
    replyEditor: ".comment_container #edit .ql-editor",
    replySubmit: ".comment_container .buttons .right",
    replySuccess: ""
  }
};

export function getRealForumSelectors(settings: ForumSettingsInput) {
  return {
    loginMarker: forumSelectors.real.loginMarker,
    postCommentEditor: settings.replyEditorSelector || forumSelectors.real.postCommentEditor,
    postCommentSubmit: settings.replySubmitSelector || forumSelectors.real.postCommentSubmit,
    commentItem: forumSelectors.real.commentItem,
    commentReplyButton: forumSelectors.real.commentReplyButton,
    nestedReplyEditorScoped: forumSelectors.real.nestedReplyEditorScoped,
    nestedReplyEditorFallback: forumSelectors.real.nestedReplyEditorFallback,
    nestedReplySubmitScoped: forumSelectors.real.nestedReplySubmitScoped,
    nestedReplySubmitFallback: forumSelectors.real.nestedReplySubmitFallback,
    replyEditor: settings.replyEditorSelector || forumSelectors.real.replyEditor,
    replySubmit: settings.replySubmitSelector || forumSelectors.real.replySubmit,
    replySuccess: settings.replySuccessSelector || forumSelectors.real.replySuccess
  };
}
