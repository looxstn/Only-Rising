// Multi-page configuration
// Add new pages here when expanding to more Instagram accounts

const pages = {
  charmframes: {
    name: 'charmframes',
    igAccountId: '17841403035264634',
    facebookPageId: '106658695543993',
    // Each page can have its own page token if needed
    // For now they all use the same one from .env
  },
  // To add a new page:
  // 1. Connect the Instagram account to a Facebook Page in Meta Business Suite
  // 2. Get the Instagram Account ID and Facebook Page ID
  // 3. Add an entry here
  // 4. If using a different FB page, generate a page token for it
  //
  // Example:
  // newpage: {
  //   name: 'newpage',
  //   igAccountId: '...',
  //   facebookPageId: '...',
  // },
};

// Reverse lookup: find page config by Instagram Account ID
function getPageByIgId(igAccountId) {
  return Object.values(pages).find(p => p.igAccountId === igAccountId) || null;
}

// Reverse lookup: find page config by Facebook Page ID
function getPageByFbId(facebookPageId) {
  return Object.values(pages).find(p => p.facebookPageId === facebookPageId) || null;
}

module.exports = { pages, getPageByIgId, getPageByFbId };
