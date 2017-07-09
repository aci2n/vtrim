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
		var tokens = value.split('x', 3);

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
	var name = script_name() + '-' + opt;
	var value = mp.get_opt(name);

	return value || def;
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

function get_selected_tracks() {
	var tracks = mp.get_property_native('track-list');
	var map = {};

	for (var i = 0; i < tracks.length; i++) {
		var track = tracks[i];

		if (track.selected) {
			map[track.type] = track;
		}
	}

	return map;
}

function get_output_full(output) {
	return mp.utils.join_path(mp.get_property('working-directory'), output);
}

// ffmpeg

function map_default(track) {
	return {
		id: '0:' + track['ff-index'],
		extra: null
	};
}

function map_video(tracks, options, map_state) {
	var map = null;

	if (tracks.video && !map_state.no_video) {
		map = map_default(tracks.video);
	}

	return map;
}

function map_audio(tracks, options) {
	var map = null;

	if (tracks.audio && !options.no_audio) {
		map = map_default(tracks.audio);
	}

	return map;
}

function map_sub_picture_based(video, sub) {
	var id = '[v]';
	var video_id = map_default(video).id;
	var sub_id = map_default(sub).id;
	var filter = '[' + video_id + '][' + sub_id + ']overlay' + id;

	return {
		id: id,
		extra: [
			'-filter_complex',
			filter
		]
	};
}

function map_sub_burn_in(sub, input, size, start) {
	var filter = 'subtitles=\'' + input + '\':si=' + (sub.id - 1);

	if (size) {
		filter += ':original_size=' + size;
	}

	return {
		id: null,
		extra: [
			'-filter:v',
			filter
		]
	};
}

function map_sub(tracks, options, map_state, current) {
	var map = null;

	if (tracks.sub && tracks.video && !options.no_sub) {
		var sub = tracks.sub;
		var picture_based = sub.codec === 'hdmv_pgs_subtitle' || sub.codec === 'dvd_subtitle';

		if (picture_based) {
			map = map_sub_picture_based(tracks.video, sub);
			map_state.no_video = true;
		} else if (options.burn_in) {
			map = map_sub_burn_in(sub, current.input, current.size, current.start);
		} else {
			map = map_default(sub);
		}
	}

	return map;
}

function ffmpeg_map_tracks(tracks, options, current) {
	var args = [];
	var map_state = {no_video: false};
	var maps = [
		map_sub(tracks, options, map_state, current),
		map_audio(tracks, options),
		map_video(tracks, options, map_state)
	];

	for (var i = 0; i < maps.length; i++) {
		var map = maps[i];

		if (map) {
			if (map.extra) {
				args = args.concat(map.extra);
			}
			if (map.id) {
				args.push('-map');
				args.push(map.id);
			}
		}
	}

	return args;
}

function get_codec_hacks(ext, options) {
	var codec_hacks = [];

	if (!options.no_audio) {
		var libopus = options.audio_codec === 'libopus' || (ext === 'webm' && !options.audio_codec);

		if (libopus && get_audio_channels() === '5.1(side)') {
			codec_hacks.push('-filter:a');
			codec_hacks.push('channelmap=channel_layout=5.1');
		}
	}

	return codec_hacks;
}

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

function format_output_file(name, ext, start, end) {
	return name + ' [' + start.toFixed(3) + '-' + end.toFixed(3) + '].' + ext;
}

function ffmpeg_calc_size(hint, video_size) {
	var result = null;

	if (hint) {
		var size = calc_size(hint, video_size);
		result = size.w + 'x' + size.h;
	}

	return result;
}

function get_ffmpeg_args(start, end, options) {
	var path = get_path();
	var input = path.full;
	var ext = options.ext || path.ext;
	var output = format_output_file(path.no_ext, ext, start, end);
	var duration = end - start;
	var tracks = get_selected_tracks();
	var size = ffmpeg_calc_size(options.size_hint, get_video_size());
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
	if (options.video_bitrate) {
		args.push('-b:v');
		args.push(options.video_bitrate);
	}
	if (options.audio_bitrate) {
		args.push('-b:a');
		args.push(options.audio_bitrate);
	}
	if (size) {
		args.push('-s:v');
		args.push(size);
	}
	args = args.concat(get_codec_hacks(ext, options));
	args = args.concat(ffmpeg_map_tracks(tracks, options, {
		input: input,
		size: size,
		start: start
	}));
	args.push(output);
	dump(args);

	return args;
}

function ffmpeg_result(handle, options, output) {
	function format(message, success) {
		return {
			message: message,
			output: output,
			success: success === true
		};
	}

	if (options.detached) {
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

	if (options.loglevel !== 'error') {
		return format('Ignoring ffmpeg output since loglevel is not error.', true);
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

	return ffmpeg_result(handle, options, args[args.length - 1]);
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
			var pattern = new RegExp('<' + key + '>', 'g');
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

// Main

(function main() {
	var ffmpeg = get_opt('ffmpeg', 'ffmpeg');
	var video_bitrate = get_opt('video-bitrate', '1M');
	var audio_bitrate = get_opt('audio-bitrate', null);
	var size_hint = parse_size_hint(get_opt('size-hint', null));
	var ext = get_opt('ext', 'webm');
	var loglevel = get_opt('loglevel', 'error');
	var video_codec = get_opt('video-codec', null);
	var audio_codec = get_opt('audio-codec', null);
	var sub_codec = get_opt('sub-codec', get_default_sub_codec(ext));
	var hooks = parse_hooks(get_opt('hooks', null));
	var burn_in = get_opt('burn-in', 'false') === 'true';

	function create_handler(no_sub, no_audio, detached) {
		var options = {
			no_sub: no_sub,
			no_audio: no_audio,
			detached: detached,
			ffmpeg: ffmpeg,
			video_bitrate: video_bitrate,
			audio_bitrate: audio_bitrate,
			size_hint: size_hint,
			ext: ext,
			loglevel: loglevel,
			video_codec: video_codec,
			audio_codec: audio_codec,
			sub_codec: sub_codec,
			hooks: hooks,
			burn_in: burn_in
		};

		return function handler() {
			handle_start(options);
		};
	}

	mp.add_key_binding('n', 'default', create_handler(false, false, false));
	mp.add_key_binding('shift+n', 'no-sub', create_handler(true, false, false));
	mp.add_key_binding('ctrl+n', 'no-audio', create_handler(false, true, false));
	mp.add_key_binding('ctrl+shift+n', 'no-sub-no-audio', create_handler(true, true, false));

	mp.add_key_binding('alt+n', 'default-detached', create_handler(false, false, true));
	mp.add_key_binding('alt+shift+n', 'no-sub-detached', create_handler(true, false, true));
	mp.add_key_binding('alt+ctrl+n', 'no-audio-detached', create_handler(false, true, true));
	mp.add_key_binding('alt+ctrl+shift+n', 'no-sub-no-audio-detached', create_handler(true, true, true));
}());