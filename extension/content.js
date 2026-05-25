// Gmail Follow-up Automator Content Script
(function() {
  'use strict';

  let settings = {};
  let trackedThreads = {};
  let isProcessingFollowups = false;
  
  // Load settings from storage
  chrome.storage.sync.get(['rules', 'defaultDelay', 'sequences'], (data) => {
    settings.rules = data.rules || [];
    settings.defaultDelay = data.defaultDelay || 24;
    settings.sequences = data.sequences || [];
  });

  // Listen for settings changes
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync') {
      if (changes.rules) settings.rules = changes.rules.newValue;
      if (changes.defaultDelay) settings.defaultDelay = changes.defaultDelay.newValue;
      if (changes.sequences) settings.sequences = changes.sequences.newValue;
    }
  });

  // Load tracked threads from local storage
  chrome.storage.local.get(['trackedThreads'], (data) => {
    trackedThreads = data.trackedThreads || {};
    console.log('Loaded tracked threads:', trackedThreads);
    
    // MIGRATION: Convert old format threads to new format
    migrateOldThreads();
  });

  // Migrate old thread format to new sequence format
  function migrateOldThreads() {
    let migrationCount = 0;
    
    Object.entries(trackedThreads).forEach(([threadId, thread]) => {
      // Check if thread is in old format (has pendingFollowup but no pendingFollowups array)
      if ((thread.pendingFollowup || thread.followupScheduledFor) && !thread.pendingFollowups) {
        console.log('Migrating thread:', threadId);
        
        // Convert to new format
        thread.pendingFollowups = [];
        
        // If there's a scheduled follow-up, add it to the array
        if (thread.pendingFollowup && thread.followupScheduledFor) {
          const message = thread.followupRule ? thread.followupRule.template : 
                         'Hi {firstName},\n\nJust following up on my previous email.\n\nBest regards';
          
          thread.pendingFollowups.push({
            stepIndex: 0,
            message: message,
            scheduledFor: thread.followupScheduledFor
          });
        }
        
        // Initialize new fields
        thread.currentStepIndex = 0;
        thread.followupSequenceIndex = thread.followupRuleIndex || null;
        thread.converted = true;
        
        migrationCount++;
      }
    });
    
    if (migrationCount > 0) {
      console.log(`✅ Migrated ${migrationCount} threads from old format to new sequence format`);
      saveTrackedThreads();
    } else {
      console.log('No threads needed migration');
    }
  }

  // Save tracked threads to local storage
  function saveTrackedThreads() {
    chrome.storage.local.set({ trackedThreads: trackedThreads });
  }

  // Extract thread ID from Gmail URL
  function getThreadIdFromUrl() {
    const match = window.location.hash.match(/\/([a-f0-9]+)$/);
    return match ? match[1] : null;
  }

  // Extract first name from email address or display name
  function extractFirstName(emailOrName) {
    if (!emailOrName) return 'there';
    
    // Try to extract from display name format: "John Doe <email@example.com>"
    const displayMatch = emailOrName.match(/^([^<]+)</);
    if (displayMatch) {
      const name = displayMatch[1].trim();
      const firstName = name.split(/\s+/)[0];
      return firstName || 'there';
    }
    
    // Try to extract from email address
    const emailMatch = emailOrName.match(/([^@]+)@/);
    if (emailMatch) {
      const username = emailMatch[1];
      const firstName = username.split(/[._-]/)[0];
      return firstName.charAt(0).toUpperCase() + firstName.slice(1);
    }
    
    return 'there';
  }

  // Get recipient email from thread
  function getRecipientEmail() {
    // Look for "To:" field in the email
    const toFields = document.querySelectorAll('span.g2[email]');
    if (toFields.length > 0) {
      return toFields[0].getAttribute('email');
    }
    
    // Alternative: look in message headers
    const headers = document.querySelectorAll('.gE.iv.gt');
    for (const header of headers) {
      const emailMatch = header.textContent.match(/to:?\s*(.+)/i);
      if (emailMatch) {
        return emailMatch[1].trim();
      }
    }
    
    return null;
  }

  // Count sent emails in current thread
  function countSentEmails() {
    const messages = document.querySelectorAll('div.h7');
    let sentCount = 0;
    
    messages.forEach(msg => {
      // Check if message is from "me"
      const fromField = msg.querySelector('span.gD');
      if (fromField && (fromField.getAttribute('email') === 'me' || fromField.textContent.includes('me'))) {
        sentCount++;
      }
    });
    
    return sentCount;
  }

  // Check if recipient has replied
  function hasRecipientReplied(recipientEmail) {
    const messages = document.querySelectorAll('div.h7');
    const myEmail = getUserEmail();
    
    for (const msg of messages) {
      const fromField = msg.querySelector('span.gD');
      if (fromField) {
        const from = fromField.getAttribute('email') || fromField.textContent;
        // If message is from recipient (not from me), they've replied
        if (from !== 'me' && from !== myEmail && from.includes(recipientEmail.split('@')[0])) {
          return true;
        }
      }
    }
    
    return false;
  }

  // Get current user's email
  function getUserEmail() {
    const emailElement = document.querySelector('div[aria-label*="@"]');
    if (emailElement) {
      const match = emailElement.getAttribute('aria-label').match(/[\w.-]+@[\w.-]+\.\w+/);
      return match ? match[0] : null;
    }
    return null;
  }

  // Send follow-up email by simulating Gmail compose
  async function sendFollowUp(threadId, message, recipientEmail) {
    console.log('Sending follow-up for thread:', threadId);
    
    try {
      // Click reply button
      const replyBtn = document.querySelector('div[aria-label*="Reply"]');
      if (!replyBtn) {
        console.error('Reply button not found');
        return false;
      }
      
      replyBtn.click();
      
      // Wait for compose box to appear
      await sleep(1000);
      
      // Find the compose box
      const composeBox = document.querySelector('div[aria-label="Message Body"]');
      if (!composeBox) {
        console.error('Compose box not found');
        return false;
      }
      
      // Insert message
      composeBox.focus();
      await sleep(200);
      
      // Clear existing content and insert new message
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      document.execCommand('insertText', false, message);
      
      await sleep(500);
      
      // Find and click send button
      const sendBtn = document.querySelector('div[aria-label*="Send"]');
      if (!sendBtn) {
        console.error('Send button not found');
        return false;
      }
      
      sendBtn.click();
      
      console.log('Follow-up sent successfully');
      return true;
    } catch (error) {
      console.error('Error sending follow-up:', error);
      return false;
    }
  }

  // Sleep utility
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Monitor thread and schedule follow-ups
  async function monitorThread() {
    const threadId = getThreadIdFromUrl();
    if (!threadId) return;
    
    const sentCount = countSentEmails();
    const recipientEmail = getRecipientEmail();
    
    if (!recipientEmail) {
      console.log('No recipient found');
      return;
    }
    
    const recipientReplied = hasRecipientReplied(recipientEmail);
    
    // Initialize or update thread tracking
    if (!trackedThreads[threadId]) {
      trackedThreads[threadId] = {
        sentCount: sentCount,
        recipientEmail: recipientEmail,
        lastChecked: Date.now(),
        pendingFollowup: false,
        followupRuleIndex: null // Will be set when composing via extension
      };
    } else {
      const thread = trackedThreads[threadId];
      
      // If recipient replied, clear any pending follow-ups
      if (recipientReplied) {
        thread.pendingFollowup = false;
        thread.followupSentCount = 0;
        console.log('Recipient replied, clearing follow-ups');
      }
      
      // If sent count increased, update tracking
      if (sentCount > thread.sentCount) {
        thread.sentCount = sentCount;
        thread.lastChecked = Date.now();
        
        // Check if we should schedule a follow-up (only if followupRuleIndex is set)
        if (!recipientReplied && thread.followupRuleIndex !== null && thread.followupRuleIndex !== undefined) {
          const rule = settings.rules[thread.followupRuleIndex];
          
          if (rule && rule.sentCount === sentCount) {
            console.log(`Scheduling follow-up after ${sentCount} sent emails using rule index ${thread.followupRuleIndex}`);
            thread.pendingFollowup = true;
            thread.followupRule = rule;
            thread.followupScheduledFor = Date.now() + (settings.defaultDelay * 60 * 60 * 1000);
          }
        }
      }
      
      // Check if it's time to send scheduled follow-up
      if (thread.pendingFollowup && thread.followupScheduledFor && 
          Date.now() >= thread.followupScheduledFor && !recipientReplied) {
        
        const firstName = extractFirstName(recipientEmail);
        const message = thread.followupRule.template.replace(/{firstName}/g, firstName);
        
        const sent = await sendFollowUp(threadId, message, recipientEmail);
        
        if (sent) {
          thread.pendingFollowup = false;
          thread.followupSentCount = (thread.followupSentCount || 0) + 1;
          thread.sentCount += 1;
        }
      }
    }
    
    saveTrackedThreads();
  }

  // Check threads periodically
  setInterval(() => {
    if (window.location.href.includes('mail.google.com/mail/u/')) {
      monitorThread();
    }
  }, 5000);

  // Initial check
  setTimeout(() => {
    monitorThread();
  }, 2000);

  // Listen for messages from background script
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'composeEmail') {
      console.log('Received compose request:', request.data);
      composeNewEmail(request.data);
      sendResponse({ success: true });
    } else if (request.action === 'processFollowups') {
      console.log('Received processFollowups request');
      processAllPendingFollowups();
      sendResponse({ success: true });
    } else if (request.action === 'trackNewThread') {
      const { threadId, recipientEmail, followupSequenceIndex } = request.data;
      if (threadId && recipientEmail) {
        // Get the sequence
        const sequence = followupSequenceIndex !== null ? settings.sequences[followupSequenceIndex] : null;
        
        // Schedule all follow-ups in the sequence
        const pendingFollowups = [];
        if (sequence && sequence.steps) {
          let cumulativeDelay = 0;
          sequence.steps.forEach((step, index) => {
            cumulativeDelay += step.delayHours * 60 * 60 * 1000;
            pendingFollowups.push({
              stepIndex: index,
              message: step.message,
              scheduledFor: Date.now() + cumulativeDelay
            });
          });
        }
        
        trackedThreads[threadId] = {
          sentCount: 1,
          recipientEmail: recipientEmail,
          lastChecked: Date.now(),
          pendingFollowups: pendingFollowups,
          followupSequenceIndex: followupSequenceIndex,
          currentStepIndex: 0
        };
        saveTrackedThreads();
        console.log('Tracking new thread:', threadId, 'with', pendingFollowups.length, 'scheduled follow-ups');
      }
      sendResponse({ success: true });
    }
    return true;
  });

  // Process all pending follow-ups (background monitoring)
  async function processAllPendingFollowups() {
    if (isProcessingFollowups) {
      console.log('Already processing follow-ups, skipping...');
      return;
    }
    
    isProcessingFollowups = true;
    console.log('Processing all pending follow-ups...');
    
    const now = Date.now();
    const threadsToProcess = [];
    
    // Find all threads with pending follow-ups that are due
    Object.entries(trackedThreads).forEach(([id, thread]) => {
      // BACKWARD COMPATIBILITY: Handle old format
      if (thread.pendingFollowup && thread.followupScheduledFor && !thread.pendingFollowups) {
        console.log('Converting old thread format during processing:', id);
        thread.pendingFollowups = [{
          stepIndex: 0,
          message: thread.followupRule ? thread.followupRule.template : 'Follow-up',
          scheduledFor: thread.followupScheduledFor
        }];
        thread.currentStepIndex = 0;
        thread.converted = true;
      }
      
      // Check for due follow-ups in new format
      if (thread.pendingFollowups && thread.pendingFollowups.length > 0) {
        const nextFollowup = thread.pendingFollowups[0];
        if (now >= nextFollowup.scheduledFor) {
          threadsToProcess.push({ id, thread });
        }
      }
    });
    
    if (threadsToProcess.length === 0) {
      console.log('No pending follow-ups due');
      isProcessingFollowups = false;
      return;
    }
    
    console.log(`Found ${threadsToProcess.length} thread(s) with due follow-ups`);
    
    for (const { id: threadId, thread } of threadsToProcess) {
      console.log('Processing thread:', threadId);
      
      // Navigate to the thread
      window.location.hash = `#inbox/${threadId}`;
      await sleep(3000);
      
      // Check if recipient has replied
      const recipientReplied = hasRecipientReplied(thread.recipientEmail);
      
      if (recipientReplied) {
        console.log('Recipient replied, clearing follow-ups');
        thread.pendingFollowups = [];
        thread.pendingFollowup = false; // Clear old format
        thread.currentStepIndex = 0;
        saveTrackedThreads();
        continue;
      }
      
      // Send the next follow-up
      const nextFollowup = thread.pendingFollowups[0];
      const firstName = extractFirstName(thread.recipientEmail);
      const message = nextFollowup.message.replace(/{firstName}/g, firstName);
      
      const sent = await sendFollowUp(threadId, message, thread.recipientEmail);
      
      if (sent) {
        thread.pendingFollowups.shift();
        thread.currentStepIndex++;
        thread.sentCount++;
        thread.pendingFollowup = false; // Clear old format
        saveTrackedThreads();
        
        console.log(`Follow-up ${thread.currentStepIndex} sent. ${thread.pendingFollowups.length} remaining.`);
        await sleep(2000);
      }
    }
    
    // Return to inbox
    window.location.hash = '#inbox';
    isProcessingFollowups = false;
    console.log('Finished processing all follow-ups');
  }

  // Compose new email from external trigger
  async function composeNewEmail(emailData) {
    console.log('Starting compose with data:', emailData);
    
    try {
      const { to, subject, body, followupRuleIndex } = emailData;
      
      // Wait for page to be ready
      await sleep(1000);
      
      // Find and click compose button
      const composeBtn = document.querySelector('div[gh="cm"]') || 
                         document.querySelector('.T-I.T-I-KE.L3');
      
      if (!composeBtn) {
        console.error('Compose button not found');
        return;
      }
      
      console.log('Clicking compose...');
      composeBtn.click();
      await sleep(1500);
      
      // Fill recipient
      const toField = document.querySelector('textarea[name="to"]') ||
                      document.querySelector('input[name="to"]');
      if (toField) {
        console.log('Filling recipient:', to);
        toField.focus();
        await sleep(200);
        
        toField.value = to;
        toField.dispatchEvent(new Event('input', { bubbles: true }));
        toField.dispatchEvent(new Event('change', { bubbles: true }));
        toField.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
        
        await sleep(500);
        
        // Try clicking dropdown suggestion or press Tab
        setTimeout(() => {
          const suggestion = document.querySelector('div[role="option"]');
          if (suggestion) {
            suggestion.click();
          } else {
            const tabEvent = new KeyboardEvent('keydown', {
              key: 'Tab',
              keyCode: 9,
              bubbles: true
            });
            toField.dispatchEvent(tabEvent);
          }
        }, 400);
        
        await sleep(800);
      }
      
      // Fill subject
      const subjectField = document.querySelector('input[name="subjectbox"]');
      if (subjectField) {
        console.log('Filling subject:', subject);
        subjectField.focus();
        await sleep(200);
        
        subjectField.value = subject;
        subjectField.dispatchEvent(new Event('input', { bubbles: true }));
        subjectField.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(500);
      }
      
      // Fill body
      const bodyField = document.querySelector('div[aria-label="Message Body"]');
      if (bodyField) {
        console.log('Filling body...');
        bodyField.focus();
        await sleep(300);
        
        // Convert markdown-style links [text](url) to HTML
        let processedBody = body.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
        processedBody = processedBody.replace(/\n/g, '<br>');
        
        bodyField.innerHTML = processedBody;
        bodyField.dispatchEvent(new Event('input', { bubbles: true }));
        
        console.log('Email composed successfully!');
      }
      
      // After email is sent, we need to track the thread
      // Listen for send button click
      await sleep(1000);
      const sendBtn = document.querySelector('div[aria-label*="Send"]');
      if (sendBtn) {
        const originalClick = sendBtn.click.bind(sendBtn);
        sendBtn.addEventListener('click', async () => {
          console.log('Send button clicked, waiting for thread creation...');
          
          // Wait for email to send and thread to be created
          await sleep(3000);
          
          // Try to get the thread ID
          const threadId = getThreadIdFromUrl();
          if (threadId) {
            console.log('New thread created:', threadId);
            
            // Get the sequence
            const sequence = followupSequenceIndex !== null ? settings.sequences[followupSequenceIndex] : null;
            
            // Schedule all follow-ups in the sequence
            const pendingFollowups = [];
            if (sequence && sequence.steps) {
              let cumulativeDelay = 0;
              sequence.steps.forEach((step, index) => {
                cumulativeDelay += step.delayHours * 60 * 60 * 1000;
                pendingFollowups.push({
                  stepIndex: index,
                  message: step.message,
                  scheduledFor: Date.now() + cumulativeDelay
                });
              });
            }
            
            trackedThreads[threadId] = {
              sentCount: 1,
              recipientEmail: to,
              lastChecked: Date.now(),
              pendingFollowups: pendingFollowups,
              followupSequenceIndex: followupSequenceIndex,
              currentStepIndex: 0
            };
            saveTrackedThreads();
            console.log('Thread tracked with', pendingFollowups.length, 'scheduled follow-ups');
          }
        });
      }
      
    } catch (error) {
      console.error('Error composing email:', error);
    }
  }

  console.log('Gmail Follow-up Automator loaded');
})();