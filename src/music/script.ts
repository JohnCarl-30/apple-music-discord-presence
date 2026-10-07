/** Unit separator. Chosen because it cannot occur in Music.app metadata. */
export const FIELD_SEP = "\u001f";

/** Returned when Music.app is not running. */
export const NOT_RUNNING = "NOT_RUNNING";

/** Returned when nothing is playing or the current track is unreadable. */
export const STOPPED = "STOPPED";

/**
 * AppleScript's literal for an unset property. It is NOT an error, so a `try`
 * block does not catch it — it coerces to this exact string and would other-
 * wise flow through as data ("missing value" shown as the album name, or an
 * unparseable duration that blanks the presence on every poll).
 */
export const MISSING_VALUE = "missing value";

export const NOW_PLAYING_SCRIPT = `
on clean(t)
	if t is missing value then return ""
	set s to t as text
	set AppleScript's text item delimiters to {(ASCII character 31), return, linefeed, tab}
	set parts to text items of s
	set AppleScript's text item delimiters to " "
	set r to parts as text
	set AppleScript's text item delimiters to ""
	return r
end clean

tell application "Music"
	if it is not running then return "${NOT_RUNNING}"
	set ps to player state as text
	if ps is "stopped" then return "${STOPPED}"
	try
		set t to current track
	on error
		return "${STOPPED}"
	end try
	set pid to ""
	try
		set pid to persistent ID of t
	end try
	if pid is missing value then set pid to ""
	set dur to 0
	try
		set dur to duration of t
	end try
	if dur is missing value then set dur to 0
	set pos to 0
	try
		set pos to player position
	end try
	if pos is missing value then set pos to 0
	-- Emitted as integers: 1-second granularity is well inside the seek
	-- tolerance, and it avoids \`real as text\` honouring a locale's comma
	-- decimal separator, which would make every duration unparseable.
	set out to {ps, pid, my clean(name of t), my clean(artist of t), my clean(album of t), (round dur) as text, (round pos) as text}
	set AppleScript's text item delimiters to (ASCII character 31)
	set r to out as text
	set AppleScript's text item delimiters to ""
	return r
end tell
`;
