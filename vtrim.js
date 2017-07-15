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

/* global mp, dump */

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

function is_undefined(value) {
	return typeof value === 'undefined';
}

function get_file_parts(filename) {
	var dir = null;
	var name = null;

	if (is_string(filename)) {
		var last_slash = filename.lastIndexOf('/');
		var last_backslash = filename.lastIndexOf('\\');
		var index = Math.max(last_slash, last_backslash) + 1;

		dir = filename.substring(0, index);
		name = filename.substring(index);
	}

	return {
		dir: dir,
		name: name
	};
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
	var ab_loop = null;
	var a = mp.get_property_number('ab-loop-a');
	var b = mp.get_property_number('ab-loop-b');

	if (is_number(a) && is_number(b)) {
		ab_loop = {
			a: a,
			b: b
		};
	}

	return ab_loop;
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

	return is_undefined(value) ? def : value;
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

function join_path(dir, name) {
	return mp.utils.join_path(dir, name);
}

function maybe_join_path(dir, name) {
	var joined = name;

	if (dir) {
		var parts = get_file_parts(name);
		joined = join_path(dir, parts.name);
	}

	return joined;
}

function get_temp_dir() {
	var script_file = mp.get_script_file();
	var parts = get_file_parts(script_file);

	return join_path(parts.dir, 'vtrim');
}

function get_audio_params() {
	return mp.get_property_native('audio-params');
}

// ffmpeg

function ffmpeg_result(handle, detached, output, process_time) {
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

	return format('Output: ' + output + '. Took: ' + process_time + 'ms.', true);
}

function ffmpeg_subprocess(args, detached) {
	var subprocess_type = detached ? 'subprocess_detached' : 'subprocess';
	var process_start = Date.now();
	var handle = mp.utils[subprocess_type]({
		args: args,
		cancellable: false
	});
	var process_time = Date.now() - process_start;

	return ffmpeg_result(handle, detached, args[args.length - 1], process_time);
}

function ffmpeg_get_initial_args(current, options, before_input) {
	var args = [];

	args.push(options.ffmpeg);
	args.push('-y');
	if (options.loglevel) {
		args.push('-v');
		args.push(options.loglevel);
	}
	args.push('-ss');
	args.push(current.start);
	if (before_input) {
		args = args.concat(before_input);
	}
	args.push('-i');
	args.push(current.input);
	args.push('-t');
	args.push(current.end - current.start);

	return args;
}

function map_default(track) {
	return '0:' + track['ff-index'];
}

function map_video(video) {
	var map = null;

	if (video && !video.map_skip) {
		map = map_default(video);
	}

	return map;
}

function map_audio(audio, current, options) {
	var map = null;

	if (audio && !options.no_audio) {
		var audio_params = get_audio_params();
		var libopus = options.audio_codec === 'libopus' || (current.ext === 'webm' && !options.audio_codec);

		if (libopus) {
			var channel_layout = audio_params.channels;

			if (channel_layout === '5.1(side)') {
				channel_layout = '5.1';
			}

			current.filters.audio.push('channelmap=channel_layout=' + channel_layout);
		}

		map = map_default(audio);
	}

	return map;
}

function map_sub_picture_based(sub, video, current) {
	var id = '[v]';
	var video_id = map_default(video);
	var sub_id = map_default(sub);
	var filter = '[' + video_id + '][' + sub_id + ']overlay' + id;

	current.filters.complex.push(filter);
	video.map_skip = true;

	return id;
}

function ffprobe_get_attachments(current, options) {
	var attachments = null;

	if (options.ffprobe) {
		var args = [];

		args.push(options.ffprobe);
		args.push('-v');
		args.push('quiet');
		args.push('-show_streams');
		args.push('-select_streams');
		args.push('t');
		args.push('-of');
		args.push('json');
		args.push(current.input);

		if (options.debug) {
			dump(args);
		}

		var handle = mp.utils.subprocess({
			args: args,
			cancellable: false
		});

		if (handle.stdout) {
			try {
				var result = JSON.parse(handle.stdout);
				attachments = result.streams;
			} catch (e) {
				if (options.debug) {
					dump(e);
				}
			}
		} else {
			if (options.debug) {
				dump(handle);
			}
		}
	}

	return attachments;
}

function ffprobe_get_fonts(current, options) {
	var mimetypes = [
		'application/x-truetype-font',
		'application/vnd.ms-opentype',
		'application/x-font-ttf'
	];
	var fonts = [];
	var attachments = ffprobe_get_attachments(current, options);

	if (attachments) {
		for (var i = 0; i < attachments.length; i++) {
			var attachment = attachments[i];
			var tags = attachment.tags;

			if (tags.filename && mimetypes.indexOf(tags.mimetype) !== -1) {
				var font = {
					index: attachment.index,
					filename: tags.filename
				};
				fonts.push(font);
			}
		}
	}

	return fonts;
}

function ffmpeg_dump_fonts(current, options) {
	var args = [];

	if (options.fonts_dir) {
		var fonts = ffprobe_get_fonts(current, options);

		for (var i = 0; i < fonts.length; i++) {
			var font = fonts[i];

			args.push('-dump_attachment:' + font.index);
			args.push(join_path(options.fonts_dir, font.filename));
		}
	}

	return args;
}

function get_sub_file_output(current, options) {
	return maybe_join_path(options.ass_dir, current.output + '.ass');
}

function ffmpeg_create_sub_file(sub, current, options) {
	var result = null;
	var output = get_sub_file_output(current, options);
	var fonts = [];

	if (options.keep_fonts) {
		fonts = ffmpeg_dump_fonts(current, options);
	}

	var args = ffmpeg_get_initial_args(current, options, fonts);

	args.push('-map');
	args.push(map_default(sub));
	args.push(output);

	if (options.debug) {
		dump(args);
	}

	var subprocess_result = ffmpeg_subprocess(args, false);

	if (options.loglevel === 'error' && !subprocess_result.success) {
		print_info('Failed to create intermediate subtitles file.');

		if (options.debug) {
			dump(subprocess_result);
		}
	} else {
		result = {
			output: output,
			dumped_fonts: fonts.length > 0
		};
	}

	return result;
}

function ffmpeg_escape_filter_arg(arg) {
	var escaped = '';

	if (is_string(arg)) {
		// (´･ω･`)
		escaped = '\'' + arg.replace(/(\\|:)/g, '\\$1').replace(/([^']*)'/g, '$1\'\\\\\\\'\'') + '\'';
	}

	return escaped;
}

function map_sub_burn(sub, current, options) {
	var result = ffmpeg_create_sub_file(sub, current, options);

	if (result) {
		var escaped_sub_file = ffmpeg_escape_filter_arg(result.output);
		var filter = 'subtitles=' + escaped_sub_file;

		if (result.dumped_fonts) {
			var escaped_fonts_dir = ffmpeg_escape_filter_arg(options.fonts_dir);
			filter += ':fontsdir=' + escaped_fonts_dir;
		}

		if (current.size) {
			filter += ':original_size=' + current.size;
		}

		current.filters.video.push(filter);
	}

	return null;
}

function map_sub(sub, video, current, options) {
	var map = null;

	if (sub && video && !options.no_sub) {
		var picture_based = sub.codec === 'hdmv_pgs_subtitle' || sub.codec === 'dvd_subtitle';

		if (picture_based) {
			map = map_sub_picture_based(sub, video, current);
		} else if (options.burn_sub) {
			map = map_sub_burn(sub, current, options);
		} else {
			map = map_default(sub);
		}
	}

	return map;
}

function ffmpeg_map_tracks(current, options) {
	var args = [];
	var tracks = get_selected_tracks();
	var maps = [
		map_sub(tracks.sub, tracks.video, current, options),
		map_audio(tracks.audio, current, options),
		map_video(tracks.video)
	];

	for (var i = 0; i < maps.length; i++) {
		var map = maps[i];

		if (map) {
			args.push('-map');
			args.push(map);
		}
	}

	return args;
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

function get_video_output(name, ext, start, end, video_dir) {
	return maybe_join_path(video_dir, name + ' [' + start.toFixed(3) + '-' + end.toFixed(3) + '].' + ext);
}

function ffmpeg_calc_size(hint, video_size) {
	var result = null;

	if (hint) {
		var size = calc_size(hint, video_size);
		result = size.w + 'x' + size.h;
	}

	return result;
}

function ffmpeg_filters(filters) {
	var args = [];
	var map = {
		video: {
			name: 'vf',
			sep: ','
		},
		audio: {
			name: 'af',
			sep: ','
		},
		complex: {
			name: 'filter_complex',
			sep: ';'
		}
	};

	for (var type in map) {
		if (map.hasOwnProperty(type)) {
			var type_filters = filters[type];

			if (type_filters.length > 0) {
				var type_data = map[type];
				var joined = type_filters.join(type_data.sep);

				args.push('-' + type_data.name);
				args.push(joined);
			}
		}
	}

	return args;
}

function ffmpeg_get_args(start, end, options) {
	var path = get_path();
	var ext = options.ext || path.ext;
	var current = {
		input: path.full,
		output: get_video_output(path.no_ext, ext, start, end, options.video_dir),
		start: start,
		ext: ext,
		end: end,
		size: ffmpeg_calc_size(options.size_hint, get_video_size()),
		filters: {
			video: [],
			audio: [],
			complex: []
		}
	};
	var args = ffmpeg_get_initial_args(current, options);

	if (options.crf) {
		args.push('-crf');
		args.push(options.crf);
	}
	if (options.threads) {
		args.push('-threads');
		args.push(options.threads);
	}
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
	if (current.size) {
		args.push('-s:v');
		args.push(current.size);
	}
	args = args.concat(ffmpeg_map_tracks(current, options));
	args = args.concat(ffmpeg_filters(current.filters));
	args.push(current.output);

	if (options.debug) {
		dump(args);
	}

	return args;
}

function run_ffmpeg(start, end, options) {
	var args = ffmpeg_get_args(start, end, options);

	return ffmpeg_subprocess(args, options.detached);
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
	var tokens = create_tokens({output: output});

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

	if (ab_loop) {
		cmd_ab_loop();
		trim_video(ab_loop.a, ab_loop.b, options);
	} else {
		print_info('A-B loop not defined.');
	}
}

// Main

(function main() {
	var ffmpeg = get_opt('ffmpeg', 'ffmpeg');
	var ffprobe = get_opt('ffprobe', 'ffprobe');
	var video_bitrate = get_opt('video-bitrate', '1M');
	var audio_bitrate = get_opt('audio-bitrate', null);
	var size_hint = parse_size_hint(get_opt('size-hint', null));
	var ext = get_opt('ext', 'webm');
	var loglevel = get_opt('loglevel', 'error');
	var video_codec = get_opt('video-codec', null);
	var audio_codec = get_opt('audio-codec', null);
	var sub_codec = get_opt('sub-codec', get_default_sub_codec(ext));
	var hooks = parse_hooks(get_opt('hooks', null));
	var burn_sub = get_opt('burn-sub', 'false') === 'true';
	var debug = get_opt('debug', 'false') === 'true';
	var keep_fonts = get_opt('keep-fonts', 'false') === 'true';
	var temp_dir = get_opt('temp-dir', get_temp_dir());
	var fonts_dir = get_opt('fonts-dir', join_path(temp_dir, 'fonts'));
	var ass_dir = get_opt('ass-dir', join_path(temp_dir, 'ass'));
	var video_dir = get_opt('video-dir', join_path(temp_dir, 'video'));
	var crf = get_opt('crf', null);
	var threads = get_opt('threads', null);

	function create_handler(no_sub, no_audio, detached) {
		var options = {
			no_sub: no_sub,
			no_audio: no_audio,
			detached: detached,
			ffmpeg: ffmpeg,
			ffprobe: ffprobe,
			video_bitrate: video_bitrate,
			audio_bitrate: audio_bitrate,
			size_hint: size_hint,
			ext: ext,
			loglevel: loglevel,
			video_codec: video_codec,
			audio_codec: audio_codec,
			sub_codec: sub_codec,
			hooks: hooks,
			burn_sub: burn_sub,
			debug: debug,
			keep_fonts: keep_fonts,
			fonts_dir: fonts_dir,
			ass_dir: ass_dir,
			video_dir: video_dir,
			crf: crf,
			threads: threads
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