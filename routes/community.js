const express = require('express');
const router = express.Router();
const db = require('../database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

// ── Keyword auto-flag patterns (emails, phone numbers, company names pattern)
const SENSITIVE_PATTERNS = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/,  // emails
  /(\+63|0)(9\d{9}|\d{10})/,                                  // PH phone numbers
  /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/,                       // generic phone
];

function scanForSensitiveContent(text) {
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

const VALID_CATEGORIES = ['Getting Started', 'Clients', 'Skills', 'Salary', 'Work Issues', 'General'];

// ─── GET /api/community/posts ─────────────────────────────────────────────────
router.get('/posts', async (req, res) => {
  const { category, search, sort = 'recent', page = 1, limit = 15 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let where = "WHERE p.is_removed = 0";
  const params = [];

  if (category && category !== 'all') {
    where += ' AND p.category = ?';
    params.push(category);
  }
  if (search) {
    where += ' AND (p.title ILIKE ? OR p.body ILIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }

  const orderBy = sort === 'popular' ? 'p.upvotes DESC' : 'p.created_at DESC';

  try {
    const countRow = await db.prepare(`SELECT COUNT(*) as count FROM community_posts p ${where}`).get(...params);
    const total = parseInt(countRow.count);

    const posts = await db.prepare(`
      SELECT p.*, u.full_name as author_name, u.profile_pic as author_pic, u.role as author_role,
        (SELECT COUNT(*) FROM community_comments c WHERE c.post_id = p.id AND c.is_removed = 0) as comment_count
      FROM community_posts p
      JOIN users u ON p.author_id = u.id
      ${where}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), offset);

    res.json({ posts, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (err) {
    console.error('[community posts] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch posts' });
  }
});

// ─── GET /api/community/posts/:id ─────────────────────────────────────────────
router.get('/posts/:id', async (req, res) => {
  try {
    const post = await db.prepare(`
      SELECT p.*, u.full_name as author_name, u.profile_pic as author_pic, u.role as author_role
      FROM community_posts p
      JOIN users u ON p.author_id = u.id
      WHERE p.id = ? AND p.is_removed = 0
    `).get(parseInt(req.params.id));

    if (!post) return res.status(404).json({ error: 'Post not found' });

    const comments = await db.prepare(`
      SELECT c.*, u.full_name as author_name, u.profile_pic as author_pic, u.role as author_role
      FROM community_comments c
      JOIN users u ON c.author_id = u.id
      WHERE c.post_id = ? AND c.is_removed = 0
      ORDER BY c.is_best_answer DESC, c.created_at ASC
    `).all(post.id);

    res.json({ ...post, comments });
  } catch (err) {
    console.error('[community post detail] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch post' });
  }
});

// ─── POST /api/community/posts ────────────────────────────────────────────────
router.post('/posts', authenticateToken, async (req, res) => {
  const { title, body, category } = req.body;

  if (!title || !body) return res.status(400).json({ error: 'title and body are required' });
  if (title.length > 200) return res.status(400).json({ error: 'Title too long (max 200 chars)' });
  if (body.length > 5000) return res.status(400).json({ error: 'Body too long (max 5000 chars)' });

  const cat = VALID_CATEGORIES.includes(category) ? category : 'General';
  const isFlagged = scanForSensitiveContent(title + ' ' + body) ? 1 : 0;

  try {
    const result = await db.prepare(
      'INSERT INTO community_posts (author_id, title, body, category, is_flagged) VALUES (?, ?, ?, ?, ?)'
    ).run(req.user.id, title, body, cat, isFlagged);

    const post = await db.prepare(`
      SELECT p.*, u.full_name as author_name
      FROM community_posts p JOIN users u ON p.author_id = u.id
      WHERE p.id = ?
    `).get(result.lastInsertRowid);

    res.status(201).json({
      ...post,
      flagged_warning: isFlagged ? 'Your post has been flagged for review due to potentially sensitive content.' : null,
    });
  } catch (err) {
    console.error('[create post] error:', err.message);
    res.status(500).json({ error: 'Failed to create post' });
  }
});

// ─── POST /api/community/posts/:id/comments ───────────────────────────────────
router.post('/posts/:id/comments', authenticateToken, async (req, res) => {
  const { body } = req.body;
  if (!body) return res.status(400).json({ error: 'body is required' });
  if (body.length > 2000) return res.status(400).json({ error: 'Comment too long (max 2000 chars)' });

  const isFlagged = scanForSensitiveContent(body) ? 1 : 0;

  try {
    const post = await db.prepare('SELECT id FROM community_posts WHERE id = ? AND is_removed = 0').get(parseInt(req.params.id));
    if (!post) return res.status(404).json({ error: 'Post not found' });

    const result = await db.prepare(
      'INSERT INTO community_comments (post_id, author_id, body, is_flagged) VALUES (?, ?, ?, ?)'
    ).run(post.id, req.user.id, body, isFlagged);

    const comment = await db.prepare(`
      SELECT c.*, u.full_name as author_name, u.profile_pic as author_pic
      FROM community_comments c JOIN users u ON c.author_id = u.id
      WHERE c.id = ?
    `).get(result.lastInsertRowid);

    res.status(201).json({
      ...comment,
      flagged_warning: isFlagged ? 'Your comment has been flagged for review.' : null,
    });
  } catch (err) {
    console.error('[create comment] error:', err.message);
    res.status(500).json({ error: 'Failed to create comment' });
  }
});

// ─── POST /api/community/posts/:id/upvote ─────────────────────────────────────
router.post('/posts/:id/upvote', authenticateToken, async (req, res) => {
  try {
    const post = await db.prepare('SELECT id, upvotes FROM community_posts WHERE id = ? AND is_removed = 0').get(parseInt(req.params.id));
    if (!post) return res.status(404).json({ error: 'Post not found' });

    const existing = await db.prepare('SELECT id FROM community_upvotes WHERE post_id = ? AND user_id = ?').get(post.id, req.user.id);
    if (existing) {
      // Toggle off
      await db.prepare('DELETE FROM community_upvotes WHERE post_id = ? AND user_id = ?').run(post.id, req.user.id);
      await db.prepare('UPDATE community_posts SET upvotes = GREATEST(0, upvotes - 1) WHERE id = ?').run(post.id);
      return res.json({ upvoted: false });
    }

    await db.prepare('INSERT INTO community_upvotes (post_id, user_id) VALUES (?, ?)').run(post.id, req.user.id);
    await db.prepare('UPDATE community_posts SET upvotes = upvotes + 1 WHERE id = ?').run(post.id);
    res.json({ upvoted: true });
  } catch (err) {
    console.error('[upvote] error:', err.message);
    res.status(500).json({ error: 'Failed to upvote' });
  }
});

// ─── POST /api/community/posts/:id/bookmark ───────────────────────────────────
router.post('/posts/:id/bookmark', authenticateToken, async (req, res) => {
  try {
    const post = await db.prepare('SELECT id FROM community_posts WHERE id = ? AND is_removed = 0').get(parseInt(req.params.id));
    if (!post) return res.status(404).json({ error: 'Post not found' });

    const existing = await db.prepare('SELECT id FROM community_bookmarks WHERE post_id = ? AND user_id = ?').get(post.id, req.user.id);
    if (existing) {
      await db.prepare('DELETE FROM community_bookmarks WHERE post_id = ? AND user_id = ?').run(post.id, req.user.id);
      return res.json({ bookmarked: false });
    }

    await db.prepare('INSERT INTO community_bookmarks (post_id, user_id) VALUES (?, ?)').run(post.id, req.user.id);
    res.json({ bookmarked: true });
  } catch (err) {
    console.error('[bookmark] error:', err.message);
    res.status(500).json({ error: 'Failed to bookmark' });
  }
});

// ─── POST /api/community/report ───────────────────────────────────────────────
router.post('/report', authenticateToken, async (req, res) => {
  const { content_type, content_id, reason } = req.body;
  if (!['post', 'comment'].includes(content_type) || !content_id) {
    return res.status(400).json({ error: 'content_type (post|comment) and content_id are required' });
  }

  try {
    await db.prepare(
      'INSERT INTO community_reports (content_type, content_id, reporter_id, reason) VALUES (?, ?, ?, ?)'
    ).run(content_type, parseInt(content_id), req.user.id, reason || '');

    res.json({ message: 'Report submitted. Thank you for helping keep the community safe.' });
  } catch (err) {
    console.error('[report] error:', err.message);
    res.status(500).json({ error: 'Failed to submit report' });
  }
});

// ─── PUT /api/community/comments/:id/best-answer ─────────────────────────────
router.put('/comments/:id/best-answer', authenticateToken, async (req, res) => {
  try {
    const comment = await db.prepare(`
      SELECT c.*, j.employer_id FROM community_comments c
      JOIN community_posts p ON c.post_id = p.id
      LEFT JOIN jobs j ON j.id = 0
      WHERE c.id = ?
    `).get(parseInt(req.params.id));

    if (!comment) return res.status(404).json({ error: 'Comment not found' });

    // Only the post author can mark best answer
    const post = await db.prepare('SELECT author_id FROM community_posts WHERE id = ?').get(comment.post_id);
    if (post.author_id !== req.user.id) return res.status(403).json({ error: 'Only the post author can mark best answer' });

    await db.prepare('UPDATE community_comments SET is_best_answer = 0 WHERE post_id = ?').run(comment.post_id);
    await db.prepare('UPDATE community_comments SET is_best_answer = 1 WHERE id = ?').run(comment.id);
    res.json({ message: 'Best answer marked' });
  } catch (err) {
    console.error('[best-answer] error:', err.message);
    res.status(500).json({ error: 'Failed to mark best answer' });
  }
});

// ─── Admin moderation ─────────────────────────────────────────────────────────
router.get('/admin/reports', requireAdmin, async (req, res) => {
  try {
    const reports = await db.prepare(`
      SELECT r.*, u.full_name as reporter_name
      FROM community_reports r
      JOIN users u ON r.reporter_id = u.id
      WHERE r.status = 'open'
      ORDER BY r.created_at ASC
    `).all();
    res.json(reports);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

router.post('/admin/moderate', requireAdmin, async (req, res) => {
  const { content_type, content_id, action, report_id } = req.body;
  // action: 'remove' | 'dismiss'

  try {
    if (action === 'remove') {
      if (content_type === 'post') {
        await db.prepare('UPDATE community_posts SET is_removed = 1 WHERE id = ?').run(parseInt(content_id));
      } else {
        await db.prepare('UPDATE community_comments SET is_removed = 1 WHERE id = ?').run(parseInt(content_id));
      }
    }

    if (report_id) {
      const status = action === 'remove' ? 'resolved' : 'dismissed';
      await db.prepare('UPDATE community_reports SET status = ? WHERE id = ?').run(status, parseInt(report_id));
    }

    res.json({ message: `Content ${action === 'remove' ? 'removed' : 'dismissed'}` });
  } catch (err) {
    console.error('[moderate] error:', err.message);
    res.status(500).json({ error: 'Failed to moderate content' });
  }
});

// GET flagged posts/comments for admin review
router.get('/admin/flagged', requireAdmin, async (req, res) => {
  try {
    const posts = await db.prepare(
      "SELECT p.*, u.full_name as author_name FROM community_posts p JOIN users u ON p.author_id = u.id WHERE p.is_flagged = 1 AND p.is_removed = 0 ORDER BY p.created_at DESC"
    ).all();
    const comments = await db.prepare(
      "SELECT c.*, u.full_name as author_name FROM community_comments c JOIN users u ON c.author_id = u.id WHERE c.is_flagged = 1 AND c.is_removed = 0 ORDER BY c.created_at DESC"
    ).all();
    res.json({ posts, comments });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch flagged content' });
  }
});

module.exports = router;
