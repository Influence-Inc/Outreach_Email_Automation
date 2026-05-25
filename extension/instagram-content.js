// Instagram profile data extractor
(function() {
  'use strict';

  // Listen for requests from popup
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'extractInstagramData') {
      const data = extractProfileData();
      sendResponse(data);
    }
    return true;
  });

  function extractProfileData() {
    const result = {
      email: null,
      firstName: null,
      fullName: null,
      username: null
    };

    try {
      // Extract username from URL
      const urlMatch = window.location.pathname.match(/^\/([^\/]+)\/?$/);
      if (urlMatch) {
        result.username = urlMatch[1];
      }

      // Try to extract full name from profile (NOT the username header)
      // Instagram structure: username is in h2, full name is in span below it
      const nameSelectors = [
        // New Instagram layout - name is in a span with specific classes
        'header section div span.x1lliihq.x1plvlek.xryxfnj',
        'header section span.x1lliihq.x1plvlek.xryxfnj',
        // Alternative selectors for name
        'header section > div > div > span',
        'section > div > div > div > span.x1lliihq',
        // Older layouts
        'section > div span.-vDIg span',
        'header section span.-vDIg',
        // Try finding by checking text length (names are usually longer than usernames)
        'header section span'
      ];

      let foundName = false;
      
      // First pass - look for name in specific locations
      for (const selector of nameSelectors) {
        const elements = document.querySelectorAll(selector);
        for (const element of elements) {
          const text = element.textContent.trim();
          
          // Skip if it's the username (matches URL username)
          if (text === result.username) continue;
          
          // Skip if it looks like a username (starts with @)
          if (text.startsWith('@')) continue;
          
          // Skip if it's just numbers or very short
          if (text.length < 2) continue;
          
          // Skip if it contains common UI text
          if (['Posts', 'Followers', 'Following', 'Reels', 'Tagged'].includes(text)) continue;
          
          // This is likely the real name
          if (text.length >= 2 && text.length < 100) {
            result.fullName = text;
            result.firstName = text.split(/\s+/)[0];
            foundName = true;
            console.log('Found name:', text);
            break;
          }
        }
        if (foundName) break;
      }

      // Second pass - if no name found, look in header more carefully
      if (!foundName) {
        const headerText = document.querySelector('header section')?.innerText || '';
        const lines = headerText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        
        // The name is usually on a line by itself, after the username
        for (const line of lines) {
          // Skip username line
          if (line === result.username) continue;
          // Skip @ mentions
          if (line.startsWith('@')) continue;
          // Skip numbers (follower counts)
          if (/^\d+$/.test(line)) continue;
          // Skip common UI text
          if (['Posts', 'Followers', 'Following', 'Reels', 'Tagged', 'posts', 'followers', 'following'].includes(line.toLowerCase())) continue;
          
          // If this line looks like a name (2-50 chars, has letters)
          if (line.length >= 2 && line.length <= 50 && /[a-zA-Z]/.test(line)) {
            result.fullName = line;
            result.firstName = line.split(/\s+/)[0];
            foundName = true;
            console.log('Found name from header text:', line);
            break;
          }
        }
      }

      // If still no name found, use username as fallback
      if (!result.firstName && result.username) {
        result.firstName = result.username.charAt(0).toUpperCase() + result.username.slice(1);
        console.log('Using username as fallback:', result.firstName);
      }

      // Extract email from bio (rest of the function remains the same)
      const bioSelectors = [
        'header section div.-vDIg span',
        'div._aa_c span',
        'header section span',
        'div[class*="x1lliihq"] span',
        'section span'
      ];

      let bioText = '';
      
      // Try multiple selectors to find bio
      for (const selector of bioSelectors) {
        const bioElements = document.querySelectorAll(selector);
        for (const element of bioElements) {
          const text = element.textContent;
          if (text && text.length > 10 && text.length < 500) {
            bioText += text + ' ';
          }
        }
        if (bioText.length > 0) break;
      }

      // Also check for email in meta tags
      const metaEmail = document.querySelector('meta[property="og:email"]');
      if (metaEmail) {
        result.email = metaEmail.getAttribute('content');
      }

      // Extract email from bio text using regex
      if (!result.email && bioText) {
        // Common email patterns
        const emailPatterns = [
          /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
          /\b[A-Za-z0-9._%+-]+\s*@\s*[A-Za-z0-9.-]+\s*\.\s*[A-Z|a-z]{2,}\b/g,
          /\b[A-Za-z0-9._%+-]+\s*\[\s*at\s*\]\s*[A-Za-z0-9.-]+\s*\.\s*[A-Z|a-z]{2,}\b/gi,
          /\b[A-Za-z0-9._%+-]+\s*\(\s*at\s*\)\s*[A-Za-z0-9.-]+\s*\.\s*[A-Z|a-z]{2,}\b/gi
        ];

        for (const pattern of emailPatterns) {
          const matches = bioText.match(pattern);
          if (matches && matches.length > 0) {
            // Clean up the email (remove spaces, replace [at] with @)
            result.email = matches[0]
              .replace(/\s+/g, '')
              .replace(/\[at\]/gi, '@')
              .replace(/\(at\)/gi, '@')
              .toLowerCase();
            break;
          }
        }
      }

      // Try to find email in clickable links
      if (!result.email) {
        const links = document.querySelectorAll('a[href^="mailto:"]');
        if (links.length > 0) {
          result.email = links[0].getAttribute('href').replace('mailto:', '');
        }
      }

      // Look for email in any visible text on the page (last resort)
      if (!result.email) {
        const allText = document.body.innerText;
        const emailMatch = allText.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/);
        if (emailMatch) {
          result.email = emailMatch[0].toLowerCase();
        }
      }

      console.log('Instagram profile data extracted:', result);
      
    } catch (error) {
      console.error('Error extracting Instagram data:', error);
    }

    return result;
  }

  console.log('Instagram content script loaded');
})();