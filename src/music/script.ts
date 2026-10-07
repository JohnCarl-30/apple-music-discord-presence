/** Unit separator. Chosen because it cannot occur in Music.app metadata. */
export const FIELD_SEP = "\u001f";

/** Returned when Music.app is not running. */
export const NOT_RUNNING = "NOT_RUNNING";

/** Returned when nothing is playing or the current track is unreadable. */
export const STOPPED = "STOPPED";

export const NOW_PLAYING_SCRIPT = `
on clean(t)
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
	set dur to 0
	try
		set dur to duration of t
	end try
	set pos to 0
	try
		set pos to player position
	end try
	set out to {ps, pid, my clean(name of t), my clean(artist of t), my clean(album of t), dur as text, pos as text}
	set AppleScript's text item delimiters to (ASCII character 31)
	set r to out as text
	set AppleScript's text item delimiters to ""
	return r
end tell
`;
