let rules = [];
let templates = [];
let sequences = [];
let currentMode = 'settings';

// Check if we're on Gmail or external site
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const currentUrl = tabs[0]?.url || '';
  const currentTab = tabs[0];
  
  if (currentUrl.includes('mail.google.com')) {
    currentMode = 'settings';
    showSettingsMode();
  } else {
    currentMode = 'compose';
    showComposeMode();
    
    if (currentUrl.includes('instagram.com')) {
      extractInstagramData(currentTab.id);
    }
  }
});

// Load settings
chrome.storage.sync.get(['rules', 'defaultDelay', 'templates', 'sequences', 'lastFollowupSequence'], (data) => {
  rules = data.rules || [];
  templates = data.templates || [];
  sequences = data.sequences || [];
  
  templates.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
  
  document.getElementById('defaultDelay').value = data.defaultDelay || 24;
  renderRules();
  renderTemplates();
  renderSequences();
  populateTemplateSelect();
  populateFollowupSequenceSelect();
  
  if (currentMode === 'compose' && templates.length > 0) {
    document.getElementById('templateSelect').value = '0';
    selectTemplate(0);
    
    if (data.lastFollowupSequence !== undefined) {
      const sequenceSelect = document.getElementById('followupSequenceSelect');
      if (sequenceSelect) {
        sequenceSelect.value = data.lastFollowupSequence;
      }
    }
  }
});

function showSettingsMode() {
  document.getElementById('pageTitle').textContent = 'Follow-up Rules';
  document.getElementById('composeMode').style.display = 'none';
  document.getElementById('settingsMode').style.display = 'block';
}

function showComposeMode() {
  document.getElementById('pageTitle').textContent = 'Send Email via Gmail';
  document.getElementById('composeMode').style.display = 'block';
  document.getElementById('settingsMode').style.display = 'none';
  document.getElementById('status').style.display = 'none';
}

function extractInstagramData(tabId) {
  chrome.tabs.sendMessage(tabId, { action: 'extractInstagramData' }, (response) => {
    if (chrome.runtime.lastError) {
      console.log('Could not extract Instagram data:', chrome.runtime.lastError.message);
      return;
    }
    
    if (response) {
      console.log('Instagram data received:', response);
      
      if (response.email) {
        document.getElementById('recipientEmail').value = response.email;
      }
      
      if (response.firstName) {
        document.getElementById('recipientFirstName').value = response.firstName;
      }
      
      if (response.email || response.firstName) {
        const status = document.getElementById('status');
        if (status) {
          status.style.display = 'block';
          status.className = 'status success';
          let message = 'Auto-filled: ';
          if (response.firstName) message += `Name: ${response.firstName}`;
          if (response.email) message += `${response.firstName ? ', ' : ''}Email: ${response.email}`;
          status.textContent = message;
          
          setTimeout(() => {
            status.style.display = 'none';
          }, 5000);
        }
      } else {
        const status = document.getElementById('status');
        if (status) {
          status.style.display = 'block';
          status.className = 'status info';
          status.textContent = 'No email found in bio. Please enter manually.';
          
          setTimeout(() => {
            status.style.display = 'none';
          }, 4000);
        }
      }
    }
  });
}

function populateTemplateSelect() {
  const select = document.getElementById('templateSelect');
  if (!select) return;
  
  select.innerHTML = '<option value="">-- Select a template --</option>';
  
  templates.forEach((template, index) => {
    const option = document.createElement('option');
    option.value = index;
    option.textContent = template.name;
    select.appendChild(option);
  });
}

function populateFollowupSequenceSelect() {
  const select = document.getElementById('followupSequenceSelect');
  if (!select) return;
  
  select.innerHTML = '<option value="">-- No automatic follow-ups --</option>';
  
  sequences.forEach((sequence, index) => {
    const option = document.createElement('option');
    option.value = index;
    const stepCount = sequence.steps ? sequence.steps.length : 0;
    option.textContent = `${sequence.name} (${stepCount} follow-up${stepCount !== 1 ? 's' : ''})`;
    select.appendChild(option);
  });
}

function selectTemplate(index) {
  const template = templates[index];
  if (template) {
    document.getElementById('emailSubject').value = template.subject || '';
    document.getElementById('emailBody').value = template.body || template.content || '';
  }
}

function renderTemplates() {
  const container = document.getElementById('templates');
  if (!container) return;
  
  container.innerHTML = '';
  
  templates.forEach((template, index) => {
    const templateDiv = document.createElement('div');
    templateDiv.className = 'template-item';
    templateDiv.innerHTML = `
      <div class="template-header">
        <input class="template-name" type="text" value="${template.name}" data-index="${index}" placeholder="Template name">
        <button class="btn-danger" data-index="${index}">Delete</button>
      </div>
      <input class="template-subject" type="text" value="${template.subject || ''}" data-index="${index}" placeholder="Email subject">
      <textarea data-index="${index}" rows="4">${template.body || template.content || ''}</textarea>
      <div class="variable-hint">Use {firstName} for name. For links: [text](url)</div>
    `;
    container.appendChild(templateDiv);
  });
  
  container.querySelectorAll('.template-name').forEach(input => {
    input.addEventListener('input', (e) => {
      const index = parseInt(e.target.dataset.index);
      templates[index].name = e.target.value;
      templates[index].lastModified = Date.now();
    });
  });
  
  container.querySelectorAll('.template-subject').forEach(input => {
    input.addEventListener('input', (e) => {
      const index = parseInt(e.target.dataset.index);
      templates[index].subject = e.target.value;
      templates[index].lastModified = Date.now();
    });
  });
  
  container.querySelectorAll('textarea').forEach(textarea => {
    textarea.addEventListener('input', (e) => {
      const index = parseInt(e.target.dataset.index);
      templates[index].body = e.target.value;
      templates[index].lastModified = Date.now();
    });
  });
  
  container.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const index = parseInt(e.target.dataset.index);
      templates.splice(index, 1);
      renderTemplates();
      populateTemplateSelect();
    });
  });
}

function renderSequences() {
  const container = document.getElementById('sequences');
  if (!container) return;
  
  container.innerHTML = '';
  
  sequences.forEach((sequence, seqIndex) => {
    const sequenceDiv = document.createElement('div');
    sequenceDiv.className = 'sequence-item';
    
    let stepsHtml = '';
    if (sequence.steps && sequence.steps.length > 0) {
      sequence.steps.forEach((step, stepIndex) => {
        stepsHtml += `
          <div class="followup-step">
            <div class="followup-step-header">
              <span>Follow-up #${stepIndex + 1}</span>
              <div>
                <span>Wait</span>
                <input type="number" class="delay-input" value="${step.delayHours || 24}" 
                       data-seq="${seqIndex}" data-step="${stepIndex}" min="1" max="720">
                <span>hours</span>
                <button class="btn-danger" style="margin-left: 8px;" data-seq="${seqIndex}" data-step="${stepIndex}">Delete</button>
              </div>
            </div>
            <textarea data-seq="${seqIndex}" data-step="${stepIndex}" rows="3">${step.message || ''}</textarea>
            <div class="variable-hint">Use {firstName} for name. For links: [text](url)</div>
          </div>
        `;
      });
    }
    
    sequenceDiv.innerHTML = `
      <div class="template-header">
        <input class="sequence-name" type="text" value="${sequence.name}" data-index="${seqIndex}" placeholder="Sequence name">
        <button class="btn-danger" data-index="${seqIndex}">Delete Sequence</button>
      </div>
      ${stepsHtml}
      <button class="btn-secondary" style="margin-top: 10px; width: 100%;" data-index="${seqIndex}">+ Add Follow-up Step</button>
    `;
    
    container.appendChild(sequenceDiv);
  });
  
  // Event listeners for sequence names
  container.querySelectorAll('.sequence-name').forEach(input => {
    input.addEventListener('input', (e) => {
      const index = parseInt(e.target.dataset.index);
      sequences[index].name = e.target.value;
    });
  });
  
  // Event listeners for delay inputs
  container.querySelectorAll('.delay-input').forEach(input => {
    input.addEventListener('input', (e) => {
      const seqIndex = parseInt(e.target.dataset.seq);
      const stepIndex = parseInt(e.target.dataset.step);
      sequences[seqIndex].steps[stepIndex].delayHours = parseInt(e.target.value);
    });
  });
  
  // Event listeners for step messages
  container.querySelectorAll('textarea').forEach(textarea => {
    textarea.addEventListener('input', (e) => {
      const seqIndex = parseInt(e.target.dataset.seq);
      const stepIndex = parseInt(e.target.dataset.step);
      sequences[seqIndex].steps[stepIndex].message = e.target.value;
    });
  });
  
  // Delete step buttons
  container.querySelectorAll('.followup-step button').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const seqIndex = parseInt(e.target.dataset.seq);
      const stepIndex = parseInt(e.target.dataset.step);
      sequences[seqIndex].steps.splice(stepIndex, 1);
      renderSequences();
      populateFollowupSequenceSelect();
    });
  });
  
  // Delete sequence buttons
  container.querySelectorAll('.template-header button').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const index = parseInt(e.target.dataset.index);
      sequences.splice(index, 1);
      renderSequences();
      populateFollowupSequenceSelect();
    });
  });
  
  // Add step buttons
  container.querySelectorAll('.btn-secondary').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const index = parseInt(e.target.dataset.index);
      if (!sequences[index].steps) sequences[index].steps = [];
      sequences[index].steps.push({
        delayHours: 24,
        message: `Hi {firstName},\n\nJust following up on my previous email.\n\nBest regards`
      });
      renderSequences();
    });
  });
}

function renderRules() {
  const container = document.getElementById('rules');
  if (!container) return;
  
  container.innerHTML = '';
  
  rules.forEach((rule, index) => {
    const ruleDiv = document.createElement('div');
    ruleDiv.className = 'rule';
    ruleDiv.innerHTML = `
      <div class="rule-header">
        <strong>After ${rule.sentCount} sent email${rule.sentCount > 1 ? 's' : ''}</strong>
        <button class="btn-danger" data-index="${index}">Delete</button>
      </div>
      <label>Follow-up message:</label>
      <textarea data-index="${index}" rows="3">${rule.template}</textarea>
      <div class="variable-hint">Use {firstName} to insert recipient's first name</div>
    `;
    container.appendChild(ruleDiv);
  });
  
  container.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const index = parseInt(e.target.dataset.index);
      rules.splice(index, 1);
      renderRules();
    });
  });
  
  container.querySelectorAll('textarea').forEach(textarea => {
    textarea.addEventListener('input', (e) => {
      const index = parseInt(e.target.dataset.index);
      rules[index].template = e.target.value;
    });
  });
}

const templateSelect = document.getElementById('templateSelect');
if (templateSelect) {
  templateSelect.addEventListener('change', (e) => {
    const index = e.target.value;
    if (index !== '') {
      selectTemplate(parseInt(index));
    }
  });
}

const addTemplateBtn = document.getElementById('addTemplate');
if (addTemplateBtn) {
  addTemplateBtn.addEventListener('click', () => {
    templates.push({
      name: `Template ${templates.length + 1}`,
      subject: '',
      body: `Hi {firstName},\n\nYour message here.\n\nBest regards`,
      lastModified: Date.now()
    });
    renderTemplates();
    populateTemplateSelect();
  });
}

const addSequenceBtn = document.getElementById('addSequence');
if (addSequenceBtn) {
  addSequenceBtn.addEventListener('click', () => {
    sequences.push({
      name: `Sequence ${sequences.length + 1}`,
      steps: [
        {
          delayHours: 24,
          message: `Hi {firstName},\n\nJust following up on my previous email. Would love to hear your thoughts.\n\nBest regards`
        }
      ]
    });
    renderSequences();
    populateFollowupSequenceSelect();
  });
}

const addRuleBtn = document.getElementById('addRule');
if (addRuleBtn) {
  addRuleBtn.addEventListener('click', () => {
    const sentCount = rules.length + 1;
    rules.push({
      sentCount: sentCount,
      template: `Hi {firstName},\n\nJust following up on my previous email. Would love to hear your thoughts.\n\nBest regards`
    });
    rules.sort((a, b) => a.sentCount - b.sentCount);
    renderRules();
  });
}

const saveBtn = document.getElementById('save');
if (saveBtn) {
  saveBtn.addEventListener('click', () => {
    const defaultDelay = parseInt(document.getElementById('defaultDelay').value);
    
    templates.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
    
    chrome.storage.sync.set({
      rules: rules,
      defaultDelay: defaultDelay,
      templates: templates,
      sequences: sequences
    }, () => {
      const status = document.getElementById('status');
      status.className = 'status success';
      status.textContent = 'Settings saved successfully!';
      setTimeout(() => {
        status.className = 'status info';
        status.textContent = 'Extension active. Visit Gmail to set up follow-ups.';
      }, 3000);
    });
  });
}

const backBtn = document.getElementById('backToSettings');
if (backBtn) {
  backBtn.addEventListener('click', () => {
    showSettingsMode();
  });
}

const sendBtn = document.getElementById('sendFromGmail');
if (sendBtn) {
  sendBtn.addEventListener('click', async () => {
    const recipientEmail = document.getElementById('recipientEmail').value.trim();
    const recipientFirstName = document.getElementById('recipientFirstName').value.trim();
    const emailSubject = document.getElementById('emailSubject').value.trim();
    const emailBody = document.getElementById('emailBody').value.trim();
    const followupSequenceIndex = document.getElementById('followupSequenceSelect')?.value;
    
    if (!recipientEmail) {
      alert('Please enter recipient email address');
      return;
    }
    
    if (!emailSubject) {
      alert('Please enter email subject');
      return;
    }
    
    if (!emailBody) {
      alert('Please enter or select an email template');
      return;
    }
    
    const firstName = recipientFirstName || extractFirstNameFromEmail(recipientEmail);
    const finalBody = emailBody.replace(/{firstName}/g, firstName);
    
    if (followupSequenceIndex !== undefined && followupSequenceIndex !== '') {
      chrome.storage.sync.set({ lastFollowupSequence: followupSequenceIndex });
    }
    
    const status = document.getElementById('status');
    status.style.display = 'block';
    status.className = 'status info';
    status.textContent = 'Opening Gmail and composing email...';
    
    chrome.runtime.sendMessage({
      action: 'composeInGmail',
      data: {
        to: recipientEmail,
        subject: emailSubject,
        body: finalBody,
        followupSequenceIndex: followupSequenceIndex !== '' ? parseInt(followupSequenceIndex) : null
      }
    }, (response) => {
      if (chrome.runtime.lastError) {
        status.className = 'status info';
        status.style.background = '#fce8e6';
        status.style.color = '#c5221f';
        status.textContent = 'Error: ' + chrome.runtime.lastError.message;
        return;
      }
      
      if (response && response.success) {
        status.className = 'status success';
        status.textContent = 'Gmail opened! Check the compose window.';
        
        setTimeout(() => {
          document.getElementById('recipientEmail').value = '';
          document.getElementById('recipientFirstName').value = '';
          document.getElementById('emailSubject').value = '';
          document.getElementById('emailBody').value = '';
          document.getElementById('templateSelect').value = '';
          
          status.textContent = 'Ready to compose another email';
        }, 3000);
      } else {
        status.className = 'status info';
        status.style.background = '#fce8e6';
        status.style.color = '#c5221f';
        status.textContent = 'Error: Could not compose email. Make sure you\'re logged into Gmail.';
      }
    });
  });
}

function extractFirstNameFromEmail(email) {
  const match = email.match(/([^@]+)@/);
  if (match) {
    const username = match[1];
    const firstName = username.split(/[._-]/)[0];
    return firstName.charAt(0).toUpperCase() + firstName.slice(1);
  }
  return 'there';
}