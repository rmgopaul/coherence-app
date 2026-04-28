package com.coherence.healthconnect.ui.widgets

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp

/**
 * Renders markdown-style and HTML-style text as styled Compose text.
 * Supports: **bold**, *italic*, <b>, <i>, <strong>, <em>, <u>, <br>, <h1>-<h3>,
 * headings (# ## ###), bullet lists (- or *), numbered lists, horizontal rules (---)
 */
@Composable
fun RichText(
  text: String,
  modifier: Modifier = Modifier,
) {
  val lines = remember(text) { parseLines(text) }

  Column(modifier = modifier.fillMaxWidth()) {
    lines.forEachIndexed { index, line ->
      when (line) {
        is RichLine.Heading -> {
          if (index > 0) Spacer(Modifier.height(8.dp))
          Text(
            text = parseInlineFormatting(line.text),
            style = when (line.level) {
              1 -> MaterialTheme.typography.titleLarge
              2 -> MaterialTheme.typography.titleMedium
              else -> MaterialTheme.typography.titleSmall
            },
            fontWeight = FontWeight.Bold,
          )
          Spacer(Modifier.height(4.dp))
        }
        is RichLine.BulletItem -> {
          Row(modifier = Modifier.padding(start = (line.indent * 16).dp, top = 2.dp, bottom = 2.dp)) {
            Text("•", style = MaterialTheme.typography.bodyMedium)
            Spacer(Modifier.width(8.dp))
            Text(
              text = parseInlineFormatting(line.text),
              style = MaterialTheme.typography.bodyMedium,
              modifier = Modifier.weight(1f),
            )
          }
        }
        is RichLine.NumberedItem -> {
          Row(modifier = Modifier.padding(start = (line.indent * 16).dp, top = 2.dp, bottom = 2.dp)) {
            Text("${line.number}.", style = MaterialTheme.typography.bodyMedium)
            Spacer(Modifier.width(8.dp))
            Text(
              text = parseInlineFormatting(line.text),
              style = MaterialTheme.typography.bodyMedium,
              modifier = Modifier.weight(1f),
            )
          }
        }
        is RichLine.Divider -> {
          Spacer(Modifier.height(8.dp))
          HorizontalDivider()
          Spacer(Modifier.height(8.dp))
        }
        is RichLine.Blank -> {
          Spacer(Modifier.height(6.dp))
        }
        is RichLine.Paragraph -> {
          Text(
            text = parseInlineFormatting(line.text),
            style = MaterialTheme.typography.bodyMedium,
          )
        }
      }
    }
  }
}

private sealed class RichLine {
  data class Heading(val level: Int, val text: String) : RichLine()
  data class BulletItem(val text: String, val indent: Int = 0) : RichLine()
  data class NumberedItem(val number: Int, val text: String, val indent: Int = 0) : RichLine()
  data class Paragraph(val text: String) : RichLine()
  data object Divider : RichLine()
  data object Blank : RichLine()
}

private fun parseLines(text: String): List<RichLine> {
  // First strip HTML block tags and convert <br> to newlines.
  //
  // Tiptap's StarterKit emits list items as `<li><p>foo</p></li>`
  // (paragraph wrapper inside each li). Without the two pre-strips
  // below, the order `</?p>` → `\n` runs first and turns
  // `<li><p>foo</p></li>` into `\n• \nfoo\n`, which splits into
  // (a) a bullet row with empty text and (b) a separate paragraph
  // with "foo". The user sees the bullet "above" the text. Strip
  // the `<p>`/`</p>` immediately inside an `<li>` boundary before
  // the global `<p>` → `\n` rewrite so the bullet text stays on
  // the same line.
  val cleaned = text
    .replace(Regex("<li>\\s*<p>", RegexOption.IGNORE_CASE), "<li>")
    .replace(Regex("</p>\\s*</li>", RegexOption.IGNORE_CASE), "</li>")
    .replace(Regex("<br\\s*/?>", RegexOption.IGNORE_CASE), "\n")
    .replace(Regex("</?p>", RegexOption.IGNORE_CASE), "\n")
    .replace(Regex("<h([1-3])>", RegexOption.IGNORE_CASE), "\n<h$1>")
    .replace(Regex("</h[1-3]>", RegexOption.IGNORE_CASE), "\n")
    .replace(Regex("</?div>", RegexOption.IGNORE_CASE), "\n")
    .replace(Regex("</?ul>", RegexOption.IGNORE_CASE), "\n")
    .replace(Regex("</?ol>", RegexOption.IGNORE_CASE), "\n")
    .replace(Regex("<li>", RegexOption.IGNORE_CASE), "\n• ")
    .replace(Regex("</li>", RegexOption.IGNORE_CASE), "")

  val lines = cleaned.split("\n")
  val result = mutableListOf<RichLine>()

  for (raw in lines) {
    val line = raw.trim()
    when {
      line.isBlank() -> result.add(RichLine.Blank)
      // Horizontal rule
      line.matches(Regex("^-{3,}$")) || line.matches(Regex("^\\*{3,}$")) || line.matches(Regex("^_{3,}$")) ->
        result.add(RichLine.Divider)
      // HTML heading
      line.matches(Regex("^<h([1-3])>(.*)$", RegexOption.IGNORE_CASE)) -> {
        val match = Regex("<h([1-3])>(.*)", RegexOption.IGNORE_CASE).find(line)
        if (match != null) {
          result.add(RichLine.Heading(match.groupValues[1].toInt(), match.groupValues[2].trim()))
        }
      }
      // Markdown heading
      line.startsWith("### ") -> result.add(RichLine.Heading(3, line.removePrefix("### ")))
      line.startsWith("## ") -> result.add(RichLine.Heading(2, line.removePrefix("## ")))
      line.startsWith("# ") -> result.add(RichLine.Heading(1, line.removePrefix("# ")))
      // Bullet item (- or * or •)
      line.matches(Regex("^\\s*[-*•]\\s+.*")) -> {
        val indent = raw.indexOfFirst { it == '-' || it == '*' || it == '•' } / 2
        val text = line.replaceFirst(Regex("^\\s*[-*•]\\s+"), "")
        result.add(RichLine.BulletItem(text, indent))
      }
      // Numbered item
      line.matches(Regex("^\\s*\\d+[.)]+\\s+.*")) -> {
        val indent = raw.indexOfFirst { it.isDigit() } / 2
        val match = Regex("^\\s*(\\d+)[.)]+\\s+(.*)").find(line)
        if (match != null) {
          result.add(RichLine.NumberedItem(match.groupValues[1].toInt(), match.groupValues[2], indent))
        } else {
          result.add(RichLine.Paragraph(line))
        }
      }
      else -> result.add(RichLine.Paragraph(line))
    }
  }

  // Remove leading/trailing blanks
  while (result.firstOrNull() is RichLine.Blank) result.removeFirst()
  while (result.lastOrNull() is RichLine.Blank) result.removeLast()

  return result
}

/**
 * Parse inline formatting: **bold**, *italic*, __bold__, _italic_,
 * <b>, <strong>, <i>, <em>, <u>, <s>
 */
private fun parseInlineFormatting(text: String): AnnotatedString {
  // First strip remaining HTML inline tags and convert to markdown equivalents
  var processed = text
    .replace(Regex("</?(?:b|strong)>", RegexOption.IGNORE_CASE), "**")
    .replace(Regex("</?(?:i|em)>", RegexOption.IGNORE_CASE), "*")
    .replace(Regex("</?u>", RegexOption.IGNORE_CASE), "__u__")
    .replace(Regex("</?(?:s|strike|del)>", RegexOption.IGNORE_CASE), "~~")
    .replace(Regex("<[^>]+>"), "") // strip any remaining HTML tags

  return buildAnnotatedString {
    var i = 0
    val chars = processed.toCharArray()
    val len = chars.size

    while (i < len) {
      when {
        // Bold: **text**
        i + 1 < len && chars[i] == '*' && chars[i + 1] == '*' -> {
          val end = processed.indexOf("**", i + 2)
          if (end > 0) {
            withStyle(SpanStyle(fontWeight = FontWeight.Bold)) {
              append(processed.substring(i + 2, end))
            }
            i = end + 2
          } else {
            append(chars[i])
            i++
          }
        }
        // Strikethrough: ~~text~~
        i + 1 < len && chars[i] == '~' && chars[i + 1] == '~' -> {
          val end = processed.indexOf("~~", i + 2)
          if (end > 0) {
            withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) {
              append(processed.substring(i + 2, end))
            }
            i = end + 2
          } else {
            append(chars[i])
            i++
          }
        }
        // Underline marker: __u__text__u__
        i + 4 < len && processed.substring(i).startsWith("__u__") -> {
          val end = processed.indexOf("__u__", i + 5)
          if (end > 0) {
            withStyle(SpanStyle(textDecoration = TextDecoration.Underline)) {
              append(processed.substring(i + 5, end))
            }
            i = end + 5
          } else {
            append(chars[i])
            i++
          }
        }
        // Italic: *text*
        chars[i] == '*' -> {
          val end = processed.indexOf("*", i + 1)
          if (end > 0) {
            withStyle(SpanStyle(fontStyle = FontStyle.Italic)) {
              append(processed.substring(i + 1, end))
            }
            i = end + 1
          } else {
            append(chars[i])
            i++
          }
        }
        else -> {
          append(chars[i])
          i++
        }
      }
    }
  }
}
