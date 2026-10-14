/** Read-only DOM snapshot. This module has no navigation, fill, upload, click, or submit APIs. */
export async function extractReadOnlyFormFields(page) {
  if (!page || typeof page.evaluate !== 'function') throw new Error('Read-only ATS inspection requires an existing page context.');
  return page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll('input, textarea, select, button'));
    return controls.map((element, index) => {
      const labels = Array.from(element.labels || []).map((label) => label.innerText || label.textContent || '');
      const labelledBy = (element.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
        .map((id) => document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || '');
      const fieldsetLabel = element.closest('fieldset')?.querySelector('legend')?.textContent || '';
      const rects = element.getClientRects();
      let hidden = false;
      for (let ancestor = element; ancestor && ancestor instanceof HTMLElement; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (ancestor.hidden || ancestor.getAttribute('aria-hidden') === 'true'
          || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
          || style.contentVisibility === 'hidden') { hidden = true; break; }
      }
      const options = element instanceof HTMLSelectElement
        ? Array.from(element.options).filter((option) => !option.disabled).map((option) => ({ value: option.value, label: option.label || option.textContent || '' }))
        : [];
      return {
        id: element.id || element.getAttribute('name') || `field-${index}`,
        name: element.getAttribute('name') || '',
        label: [...labels, ...labelledBy, fieldsetLabel].filter(Boolean).join(' ').trim(),
        type: element instanceof HTMLTextAreaElement ? 'textarea'
          : element instanceof HTMLSelectElement ? 'select'
            : element instanceof HTMLButtonElement ? 'button' : (element.getAttribute('type') || 'text').toLowerCase(),
        required: element.required === true || element.getAttribute('aria-required') === 'true',
        disabled: element.disabled === true,
        visible: rects.length > 0 && !hidden,
        options
      };
    });
  });
}
