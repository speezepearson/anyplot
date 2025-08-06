This is a command-line tool with the goal of being able to plot anything.

It takes (a) some data, and (b) a natural-language description of what it should plot, and it uses an LLM to quickly synthesize a script to plot that data in the desired way.

# Usage

Usage:

    anyplot INSTRUCTIONS [PATH]

Examples:

    $ head -n3 data.txt
    x=2983, y=15195452
    x=325, y=3656021
    x=20791, y=108369570
    $ anyplot 'cdf of y' data.txt

    $ head -n3 data.txt
    x=2983, y=15195452
    x=325, y=3656021
    x=20791, y=108369570
    $ cat data.txt | anyplot 'scatter'

# Caching

In order to avoid unnecessarily resynthesizing scripts, it should remember all of the scripts that it's written, and for each script it should remember the instructions, as well as a regular expression that matches all of the several first lines of the file. Then, later, if the script is run with the same instructions and with data whose first several lines all match that regular expression, it won't resynthesize the script, it will just use the existing one.

Examples:

    $ head -n3 data.txt
    x=2983, y=15195452
    x=325, y=3656021
    x=20791, y=108369570
    $ anyplot 'cdf of y' data.txt  # first run: synthesizes a script
    $ anyplot 'cdf of y' data.txt  # same instructions, same data: reuses previous script
    $ anyplot 'cdf of x' data.txt  # new instructions: synthesizes a new script
    $ (for i in {1..1000}; do echo "x=$i, y=$((x+RANDOM))"; done) >data.txt
    $ anyplot 'cdf of y' data.txt  # data has changed but should still match the regex designed to match the old data: reuses previous script

# Development Tips

- Whenever you think you're done with a batch of changes, run `npm run typecheck`.