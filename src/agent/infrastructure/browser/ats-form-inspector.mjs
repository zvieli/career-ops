/** Read-only DOM snapshot. This module has no navigation, fill, upload, click, or submit APIs. */
export async function extractReadOnlyFormFields(page) {
  if (!page || typeof page.evaluate !== 'function') throw new Error('Read-only ATS inspection requires an existing page context.');
  return page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll('input, textarea, select, button'));
    const forms = Array.from(document.forms);
    const describe = (element, index) => {
      const labels = Array.from(element.labels || []).map((label) => (label.innerText || label.textContent || '').trim());
      const labelledBy = (element.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
        .map((id) => (document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || '').trim());
      const group = element.closest('fieldset, [role="radiogroup"], [role="group"], [aria-labelledby]');
      const legend = group?.querySelector(':scope > legend')?.textContent?.trim() || '';
      const groupLabel = legend || (group?.getAttribute('aria-label') || '').trim()
        || (group?.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
          .map((id) => (document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || '').trim()).filter(Boolean).join(' ');
      const rects = element.getClientRects();
      let hidden = false;
      for (let ancestor = element; ancestor && ancestor instanceof HTMLElement; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (ancestor.hidden || ancestor.getAttribute('aria-hidden') === 'true' || style.display === 'none'
          || style.visibility === 'hidden' || style.visibility === 'collapse' || style.contentVisibility === 'hidden') { hidden = true; break; }
      }
      const options = element instanceof HTMLSelectElement
        ? Array.from(element.options).filter((option) => !option.disabled).map((option) => ({ value: option.value, label: (option.label || option.textContent || '').trim() }))
        : [];
      const type = element instanceof HTMLTextAreaElement ? 'textarea'
        : element instanceof HTMLSelectElement ? 'select'
          : element instanceof HTMLButtonElement ? 'button' : (element.getAttribute('type') || 'text').toLowerCase();
      return {
        element, index, formIndex: element.form ? forms.indexOf(element.form) : -1, group, groupLabel,
        id: element.id || element.getAttribute('name') || `field-${index}`, name: element.getAttribute('name') || '',
        label: [...labels, ...labelledBy].filter(Boolean).join(' ').trim(), type,
        required: element.required === true || element.getAttribute('aria-required') === 'true',
        disabled: element.disabled === true, visible: rects.length > 0 && !hidden, options
      };
    };
    const descriptors = controls.map(describe);
    const output = [];
    const consumed = new Set();
    const escapeKey = (value) => String(value).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'unnamed';
    for (const descriptor of descriptors) {
      if (consumed.has(descriptor.index)) continue;
      if (descriptor.type !== 'radio' && descriptor.type !== 'checkbox') {
        output.push({ id: descriptor.id, name: descriptor.name, label: descriptor.groupLabel || descriptor.label,
          type: descriptor.type, required: descriptor.required, disabled: descriptor.disabled,
          visible: descriptor.visible, options: descriptor.options });
        consumed.add(descriptor.index);
        continue;
      }
      const radio = descriptor.type === 'radio';
      const groupContainer = descriptor.group;
      const name = descriptor.name;
      const canGroup = Boolean(name) && (radio || Boolean(groupContainer));
      const members = canGroup ? descriptors.filter((item) => !consumed.has(item.index) && item.type === descriptor.type
        && item.formIndex === descriptor.formIndex && item.name === name
        && (radio || item.group === groupContainer)) : [descriptor];
      for (const member of members) consumed.add(member.index);
      const label = descriptor.groupLabel || (!radio && !groupContainer ? descriptor.label : '');
      const options = members.filter((item) => !item.disabled && item.visible).map((item) => ({
        value: item.element.value || '', label: item.label
      }));
      const values = options.map((option) => option.value);
      const groupLabels = new Set(members.map((item) => item.groupLabel).filter(Boolean));
      const malformed = !canGroup || !label || groupLabels.size > 1 || options.length !== members.filter((item) => !item.disabled && item.visible).length
        || options.some((option) => !option.value || !option.label) || new Set(values).size !== values.length;
      const groupId = `choice-${descriptor.type}-${descriptor.formIndex}-${descriptor.index}-${escapeKey(name)}`;
      output.push({
        id: groupId, name, label, type: malformed ? 'unsupported' : descriptor.type,
        required: members.some((item) => item.required) || groupContainer?.getAttribute('aria-required') === 'true',
        disabled: members.every((item) => item.disabled), visible: members.some((item) => item.visible), options,
        ...(malformed ? { normalization_error: 'choice_group_missing_identity_label_or_unique_options' } : {})
      });
    }
    return output;
  });
}
