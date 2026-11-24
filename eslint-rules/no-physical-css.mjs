// apps/web styles must be ready for right-to-left languages (Arabic is planned for the Gulf market), so class names use LOGICAL properties:
// ms-/me-/ps-/pe-/start-/end-/text-start/text-end/rounded-s-/rounded-e-/border-s/border-e, never
// ml-/mr-/pl-/pr-/left-/right-/text-left/text-right/rounded-l-/rounded-r-/border-l/border-r.
// (docs/02-system-design.md "Frontend structure", apps/web/CLAUDE.md.)

const PHYSICAL =
  /(?:^|\s)(?:[\w[\]=-]+:)*-?(?:(?:ml|mr|pl|pr|left|right|scroll-ml|scroll-mr|scroll-pl|scroll-pr)-[^\s]+|(?:rounded|border)-(?:l|r|tl|tr|bl|br)(?:-[^\s]+)?|text-left|text-right|float-left|float-right|clear-left|clear-right)(?=\s|$)/;

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      physical:
        'Physical direction in a class name ({{match}}). Use the logical form (ms-/me-/ps-/pe-/start-/end-/text-start/text-end/rounded-s/rounded-e) so the page works right-to-left.',
    },
  },
  create(context) {
    const check = (node, text) => {
      const match = PHYSICAL.exec(text);
      if (match) context.report({ node, messageId: 'physical', data: { match: match[0].trim() } });
    };
    return {
      Literal(node) {
        if (typeof node.value === 'string') check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.cooked ?? '');
      },
    };
  },
};

export default { rules: { 'no-physical-css': rule } };
