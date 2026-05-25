---
name: Documents
description: Read, write, convert, and analyze documents — routes to PDF, DOCX, XLSX, PPTX sub-skills for creation, editing, extraction, and format conversion. USE WHEN document, process file, create document, convert format, extract text, PDF, DOCX, XLSX, PPTX, Word, Excel, spreadsheet, PowerPoint, presentation, slides, consulting report, large PDF, merge PDF, fill form, tracked changes, redlining.
---

## Customization

**Before executing, check for user customizations at:**
`~/.claude/PAI/USER/SKILLCUSTOMIZATIONS/Documents/`

If this directory exists, load and apply any PREFERENCES.md, configurations, or resources found there. These override default behavior. If the directory does not exist, proceed with skill defaults.

User: "Create a consulting proposal doc with redlining"
→ Routes to DOCX workflows
→ Creates document with docx-js
→ Enables tracked changes for review workflow
→ Outputs professional .docx with revision marks
```

**Example 2: Fill a PDF form programmatically**
```
User: "Fill out this NDA PDF with my info"
→ Routes to PDF workflows
→ Reads form fields from PDF
→ Fills fields programmatically with pdf-lib
→ Outputs completed, flattened PDF
```

**Example 3: Build financial model spreadsheet**
```
User: "Create a revenue projection spreadsheet"
→ Routes to XLSX workflows
→ Creates workbook with openpyxl
→ Adds formulas (never hardcoded values)
→ Runs recalc.py to update calculations
```

**Example 4: Generate professional consulting report PDF**
```
User: "Create a consulting report from the assessment data"
→ Routes to ConsultingReport workflow
→ Parses report directory for data files, markdown, diagrams
→ Compresses images (PNG→JPEG, max 1200px)
→ Generates styled HTML with professional typography
→ Converts to PDF via Playwright with headers/footers
→ Outputs McKinsey-quality A4 PDF with TOC, diagrams, color boxes
```

## 🔗 Integration with Other Skills

### Feeds Into:
- **writing** skill - Creating documents for blog posts and newsletters
- **business** skill - Creating consulting proposals and financial models
- **research** skill - Extracting data from research documents

### Uses:
- **media** skill - Creating images for document illustrations
- **development** skill - Building document processing automation
- **system** skill - Command-line tools and scripting

## 🎯 Key Principles

### Document Creation
1. **Quality First** - Professional formatting and structure from the start
2. **Template Reuse** - Leverage existing templates when available
3. **Validation** - Always verify output (visual inspection, error checking)
4. **Automation** - Use scripts for repetitive tasks

### Document Editing
1. **Preserve Intent** - Maintain original formatting and structure
2. **Track Changes** - Use proper workflows for document review
3. **Batch Processing** - Group related operations for efficiency
4. **Error Prevention** - Validate before finalizing

### Document Analysis
1. **Right Tool** - Choose appropriate library/tool for the task
2. **Data Integrity** - Preserve original data when extracting/converting
3. **Format Awareness** - Understand document structure (OOXML, PDF structure, etc.)
4. **Performance** - Use efficient methods for large documents

## 📚 Full Reference Documentation

**Word Documents (DOCX):**
- Main Guide: `~/.claude/skills/Utilities/Documents/Docx/SKILL.md`
- Creation Reference: `~/.claude/skills/Utilities/Documents/Docx/docx-js.md`
- Editing Reference: `~/.claude/skills/Utilities/Documents/Docx/ooxml.md`

**PDF Processing:**
- Main Guide: `~/.claude/skills/Utilities/Documents/Pdf/SKILL.md`
- Forms Guide: `~/.claude/skills/Utilities/Documents/Pdf/forms.md`
- Advanced Reference: `~/.claude/skills/Utilities/Documents/Pdf/reference.md`

**PowerPoint Presentations (PPTX):**
- Main Guide: `~/.claude/skills/Utilities/Documents/Pptx/SKILL.md`
- Creation Reference: `~/.claude/skills/Utilities/Documents/Pptx/html2pptx.md`
- Editing Reference: `~/.claude/skills/Utilities/Documents/Pptx/ooxml.md`

**Excel Spreadsheets (XLSX):**
- Main Guide: `~/.claude/skills/Utilities/Documents/Xlsx/SKILL.md`
- Recalc Script: `~/.claude/skills/Utilities/Documents/Xlsx/recalc.py`

---

## Summary

**The documents skill provides comprehensive document processing:**

- **DOCX** - Create, edit, analyze Word documents with tracked changes support
- **PDF** - Create, manipulate, extract from PDFs with form filling capabilities
- **PPTX** - Create, edit presentations with professional design and templates
- **XLSX** - Create, edit spreadsheets with formulas and financial modeling

**Reference-based organization** - Each document type has complete guides and tooling

**Routing is automatic** - Analyzes user intent and activates appropriate document type workflow

**Professional quality** - Standards and best practices for production-ready documents
