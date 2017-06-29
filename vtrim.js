/*
	vtrim - A mpv user script to trim files using ffmpeg.
	Copyright (C) 2017  github.com/aci2n

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

/* global mp */

'use strict';

// Utilities

function is_string(value) {
	return typeof value === 'string';
}

function is_object(value) {
	return typeof value === 'object';
}

function is_number(value) {
	return typeof value === 'number' && !isNaN(value);
}

// Video resizing

function is_valid_dimension(dim) {
	return is_number(dim) && dim > 0 && dim % 2 === 0;
}

function parse_size_hint(value) {
	var hint = null;

	if (is_string(value)) {
		var tokens = value.split(':', 3);

		if (tokens.length >= 2) {
			var w = parseInt(tokens[0], 10);
			var h = parseInt(tokens[1], 10);

			if (is_valid_dimension(w) && is_valid_dimension(h)) {
				hint = {
					w: w,
					h: h,
					force: tokens[2] === 'force'
				};
			}
		}
	}

	return hint;
}

function round_even(num) {
	var op = num > 0 ? Math.floor : Math.ceil;
	return op(num + op(num % 2));
}

function calc_size(hint, video_size) {
	if (hint.force) {
		return hint;
	}

	var video_px = video_size.w * video_size.h;
	var hint_px = hint.w * hint.h;

	if (video_px <= hint_px) {
		return video_size;
	}

	var ratio = video_size.w / video_size.h;
	var h = Math.sqrt(hint_px / ratio);
	var w = ratio * h;

	return {
		w: round_even(w),
		h: round_even(h)
	};
}

// mp.* wrappers

function script_name() {
	return 'vtrim';
}

function get_ab_loop() {
	var a = mp.get_property_number('ab-loop-a');
	var b = mp.get_property_number('ab-loop-b');

	return {
		a: a,
		b: b
	};
}

function cmd_ab_loop() {
	mp.command('ab-loop');
}

function get_path() {
	var full = mp.get_property('path');
	var index = full.lastIndexOf('.');
	var ext = full.substring(index + 1);
	var no_ext = full.substring(0, index);

	return {
		full: full,
		ext: ext,
		no_ext: no_ext
	};
}

function get_opt(opt, def) {
	return mp.get_opt(script_name() + '-' + opt) || def;
}

function print_info(message, duration) {
	mp.osd_message('[' + script_name() + '] ' + message, duration || 5);
	mp.msg.info(message);
}

function get_video_size() {
	var w = mp.get_property_number('width');
	var h = mp.get_property_number('height');

	return {
		w: w,
		h: h
	};
}

function get_audio_channels() {
	return mp.get_property('audio-params/channels');
}

function is_encodable(track) {
	if (track.type === 'sub' && (track.codec === 'hdmv_pgs_subtitle' || track.codec === 'vobsub')) {
		return false;
	}

	return true;
}

function get_selected_tracks() {
	var tracks = mp.get_property_native('track-list');
	var selected = [];
	var map = {};

	for (var i = 0; i < tracks.length; i++) {
		var track = tracks[i];
		var override = !(track.type in map) || (!map[track.type].selected && track.selected);

		if (override && is_encodable(track)) {
			map[track.type] = track;
		}
	}

	for (var type in map) {
		if (map.hasOwnProperty(type)) {
			selected.push(map[type]['ff-index']);
		}
	}

	selected.sort();

	return selected;
}

function get_output_full(output) {
	return mp.utils.join_path(mp.get_property('working-directory'), output);
}

// ffmpeg

function format_output_file(name, ext, start, end) {
	return name + ' [' + start.toFixed(3) + '-' + end.toFixed(3) + '].' + ext;
}

function calc_size_ffmpeg(hint, video_size) {
	var result = calc_size(hint, video_size);
	return result.w + 'x' + result.h;
}

function get_ffmpeg_args(start, end, options) {
	var path = get_path();
	var input = path.full;
	var ext = options.ext || path.ext;
	var output = format_output_file(path.no_ext, ext, start, end);
	var duration = end - start;
	var selected_tracks = get_selected_tracks();
	var args = [];

	args.push(options.ffmpeg);
	args.push('-n');
	if (options.loglevel) {
		args.push('-v');
		args.push(options.loglevel);
	}
	args.push('-ss');
	args.push(start);
	args.push('-i');
	args.push(input);
	args.push('-t');
	args.push(duration);
	if (options.video_codec) {
		args.push('-c:v');
		args.push(options.video_codec);
	}
	if (options.audio_codec) {
		args.push('-c:a');
		args.push(options.audio_codec);
	}
	if (options.sub_codec) {
		args.push('-c:s');
		args.push(options.sub_codec);
	}
	if (options.bitrate) {
		args.push('-b:v');
		args.push(options.bitrate);
	}
	if (options.size_hint) {
		args.push('-s:v');
		args.push(calc_size_ffmpeg(options.size_hint, get_video_size()));
	}
	if (options.no_audio) {
		args.push('-an');
	} else {
		// workaround for ffmpeg issue when encoding a 5.1(side) channel layout with libopus
		if (ext === 'webm' && get_audio_channels() === '5.1(side)') {
			args.push('-filter:a');
			args.push('channelmap=channel_layout=5.1');
		}
	}
	if (options.no_subs) {
		args.push('-sn');
	}
	for (var i = 0; i < selected_tracks.length; i++) {
		args.push('-map');
		args.push('0:' + selected_tracks[i]);
	}
	args.push(output);

	return args;
}

function ffmpeg_result(handle, detached, output) {
	function format(message, success) {
		return {
			message: message,
			output: output,
			success: success === true
		};
	}

	if (detached) {
		return format('Running ffmpeg detached. Output: ' + output, true);
	}

	if (!is_object(handle)) {
		return format('Unexpected handle type: ' + typeof handle);
	}

	if (handle.stderr) {
		return format('ffmpeg error: ' + handle.stderr);
	}

	if (handle.error) {
		return format('error: ' + handle.error);
	}

	return format('Output: ' + output, true);
}

function run_ffmpeg(start, end, options) {
	var args = get_ffmpeg_args(start, end, options);
	var subprocess_type = options.detached ? 'subprocess_detached' : 'subprocess';
	var handle = mp.utils[subprocess_type]({
		args: args,
		cancellable: false
	});

	return ffmpeg_result(handle, options.detached, args[args.length - 1]);
}

// Hooks

function parse_hooks(str) {
	var hooks = [];

	if (is_string(str)) {
		var commands = str.split(';');
		for (var i = 0; i < commands.length; i++) {
			var command = commands[i];
			if (command) {
				hooks.push(command.split('|'));
			}
		}
	}

	return hooks;
}

function replace_tokens_in_arg(arg, tokens) {
	var value = arg;

	for (var i = 0; i < tokens.length; i++) {
		var token = tokens[i];
		value = value.replace(token.pattern, token.value);
	}

	return value;
}

function replace_tokens(args, tokens) {
	var replaced = [];

	for (var i = 0; i < args.length; i++) {
		var value = replace_tokens_in_arg(args[i], tokens);
		if (value) {
			replaced.push(value);
		}
	}

	return replaced;
}

function create_tokens(args) {
	var tokens = [];

	for (var key in args) {
		if (args.hasOwnProperty(key)) {
			var value = args[key];
			var pattern = new RegExp('\\$\\{' + key + '\\}', 'g');
			tokens.push({
				value: value,
				pattern: pattern
			});
		}
	}

	return tokens;
}

function hook_result(hook, handle) {
	var name = hook[0];
	var message = handle.stderr || handle.error || handle.stdout || '[no output]';

	return name + ': ' + message;
}

function run_hooks(hooks, output) {
	var tokens = create_tokens({output: get_output_full(output)});

	for (var i = 0; i < hooks.length; i++) {
		var hook = replace_tokens(hooks[i], tokens);
		var handle = mp.utils.subprocess({
			args: hook,
			cancellable: false
		});
		var result = hook_result(hook, handle);

		print_info(result);
	}
}

// Handler

function options_info(options) {
	var info = '';

	for (var key in options) {
		if (options.hasOwnProperty(key)) {
			info += ' [' + key + ': ' + JSON.stringify(options[key]) + ']';
		}
	}

	return info;
}

function trim_video(start, end, options) {
	if (end > start) {
		print_info('Running...' + options_info(options));
		var result = run_ffmpeg(start, end, options);
		print_info(result.message);

		if (result.success && !options.detached) {
			run_hooks(options.hooks, result.output);
		}
	} else {
		print_info('End time must be higher than start time.');
	}
}

function handle_start(options) {
	var ab_loop = get_ab_loop();

	if (is_number(ab_loop.a) && is_number(ab_loop.b)) {
		cmd_ab_loop();
		trim_video(ab_loop.a, ab_loop.b, options);
	} else {
		print_info('A-B loop not defined.');
	}
}

// Codecs

function get_default_sub_codec(ext) {
	switch (ext) {
	case 'mov':
	case 'mp4':
		return 'mov_text';
	case 'avi':
		return 'xsub';
	default:
		return null;
	}
}

// Main

(function main() {
	var ffmpeg = get_opt('ffmpeg', 'ffmpeg');
	var bitrate = get_opt('bitrate', '1M');
	var size_hint = parse_size_hint(get_opt('size-hint', null));
	var ext = get_opt('ext', 'webm');
	var loglevel = get_opt('loglevel', 'error');
	var video_codec = get_opt('video-codec', null);
	var audio_codec = get_opt('audio-codec', null);
	var sub_codec = get_opt('sub-codec', get_default_sub_codec(ext));
	var hooks = parse_hooks(get_opt('hooks', null));

	function create_handler(no_subs, no_audio, detached) {
		var options = {
			no_subs: no_subs,
			no_audio: no_audio,
			detached: detached,
			ffmpeg: ffmpeg,
			bitrate: bitrate,
			size_hint: size_hint,
			ext: ext,
			loglevel: loglevel,
			video_codec: video_codec,
			audio_codec: audio_codec,
			sub_codec: sub_codec,
			hooks: hooks
		};

		return function handler() {
			handle_start(options);
		};
	}

	mp.add_key_binding('n', 'default', create_handler(false, false, false));
	mp.add_key_binding('shift+n', 'no-subs', create_handler(true, false, false));
	mp.add_key_binding('ctrl+n', 'no-audio', create_handler(false, true, false));
	mp.add_key_binding('ctrl+shift+n', 'no-subs-no-audio', create_handler(true, true, false));

	mp.add_key_binding('alt+n', 'default-detached', create_handler(false, false, true));
	mp.add_key_binding('alt+shift+n', 'no-subs-detached', create_handler(true, false, true));
	mp.add_key_binding('alt+ctrl+n', 'no-audio-detached', create_handler(false, true, true));
	mp.add_key_binding('alt+ctrl+shift+n', 'no-subs-no-audio-detached', create_handler(true, true, true));
}());