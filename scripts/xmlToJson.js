/* G. Hemingway Copyright @2014
 * Convert a CAD model (per the STEPTOOLS defined XML spec) into a JSON spec model
 */

var fs = require("fs"),
    _ = require("underscore"),
    async = require("async"),
    cp = require("child_process"),
    xml2js = require("xml2js"),
    libxmljs = require("libxmljs");

var readTime = 0, parseTime = 0, translateTime = 0, writeTime = 0;
var config = {
    indexPoints: true,
    indexNormals: true,
    compressColors: true,
    roundPrecision: 2
};

/***********************************************************************/


var roundFloat = function(val, precision, toFloat) {
    if (typeof toFloat === 'undefined') toFloat = false;
    if (!precision) return val;
    var factor = Math.pow(10, precision);
    if (toFloat) return Math.round(val * factor) / factor;
    else return Math.round(val * factor);
};

/***********************************************************************/


var calculateNumberOfBatches = function(data, desired) {
    // Easiest means, either 1 or number desired
    return data.shells.length < desired ? 1 : desired;
};


function smallestBatch(batches) {
    var index = 0;
    var value = batches[0];
    for (var i = 1; i < batches.length; i++) {
        if (batches[i] < value) {
            value = batches[i];
            index = i;
        }
    }
    return index;
}

function batchShells(data, directory, translator) {
    // Setup batch sizes
    var batchSizes = [];
    var batches = [];
    for (var i = 0; i < data.batches; i++) {
        batchSizes.push(0);
        batches[i] = [];
    }
    // Sort the shells based on size - decreasing
    data.shells.sort(function(a, b) {
        return a.size < b.size;
    });
    // Pack that batch!!!
    data.shells.forEach(function(shell) {
        // Find the batch with the smallest size
        var batchID = smallestBatch(batches);
        // Push the shell into that batch
        batches[batchID].push(shell.id);
        // Update the batch size
        batchSizes[batchID] += shell.size;
    });
    var batchID = 0;
    batches.forEach(function(batch) {
        var output = {
            shells: []
        };
        batch.forEach(function(shell) {
            var path = directory + "/shell_" + shell + ".json";
            var shellData = fs.readFileSync(path);
            var json = JSON.parse(shellData);
            output.shells.push(json);
        });

        var batchName = "batch" + batchID + ".json";
        translator.write(directory, batchName, output, function() {
            console.log("Wrote batch: " + batchName);
        });
        batchID++;
    });
}

/*************************************************************************/

var translateIndex = function(doc, numBatches) {
    // Return the full JSON
    translateTime = Date.now();
    var data = {
        root:       doc.root().attr("root").value(),
        products:   _.map(doc.find("//product"), translateProduct),
        shapes:     _.map(doc.find("//shape"), translateShape),
        shells:     _.map(doc.find("//shell"), translateShell),
        annotations:_.map(doc.find("//annotation"), translateAnnotation)
    };
    // Are we going to be batching?
    if (numBatches != 0) {
        data.batches = calculateNumberOfBatches(data, numBatches);
    }
    translateTime = Date.now() - translateTime;
    return data;
};
/*
var showIndex = function(data) {
    var externalShells = _.pluck(data.shells, "href");
    var externalAnnotations = _.pluck(data.annotations, "href");
    console.log("\tProducts: " + data.products.length);
    console.log("\tShapes: " + data.shapes.length);
    console.log("\tAnnotations: " + data.annotations.length);
    console.log("\tExternal Annotations: " + externalAnnotations.length);
    console.log("\tShells: " + data.shells.length);
    console.log("\tExternal Shells: " + externalShells.length);
};
*/
var translateProduct = function(product) {
    var data = {
        "id": product.attr("id").value(),
        "step": product.attr("step").value(),
        "name": product.attr("name").value()
    };
    // Add children, if there are any
    if (product.attr("children")) {
        data.children = product.attr("children").value().split(" ");
    }
    // Add shapes, if there are any
    if (product.attr("shape").value()) {
        data.shapes = product.attr("shape").value().split(" ");
    }
    return data;
};

var setTransform = function(transform) {
    // Look for identity transforms
    if (transform === "1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1") return "I";
    // Otherwise, turn this into an array of float values
    return transform.split(" ").map(function(val) {
        return parseFloat(val);
    })
};

var translateShape = function(shape) {
    // Base Shape JSON
    var data = {
        "id": shape.attr("id").value(),
        "shells": [],
        "annotations": [],
        "children": []
    };
    // Add children, if there are any
    _.forEach(shape.find("child"), function(child) {
        data.children.push({
            "ref": child.attr("ref").value(),
            "xform": setTransform(child.attr("xform").value())
        });
    });
    // Add child annotations
    if (shape.attr("annotation")) {
        data.annotations = shape.attr("annotation").value().split(" ");
    }
    // Terminal Shape JSON
    if (shape.attr("shell")) {
        data.shells = shape.attr("shell").value().split(" ");
    }
    return data;
};

var translateAnnotation = function(annotation) {
    var data = {
        "id": annotation.attr("id").value()
    };
    // Is this a non-terminal annotation
    if (annotation.attr("href")) {
        data.href = annotation.attr("href").value().replace("xml", "json");
    // Otherwise, add all those lines
    } else {
        translateTime = Date.now();
        data.lines = _.map(annotation.find("polyline"), function(polyline) {
            var points = [];
            _.forEach(polyline.find("p"), function(line) {
                _.forEach(line.attr("l").value().split(" "), function(val) {
                    points.push(parseFloat(val));
                });
            });
            return points;
        });
        translateTime = Date.now() - translateTime;
    }
    return data;
};

/***********************************************************************/

var indexShellPoints = function(data) {
    var numPoints = data.points.length;
    data.pointsIndex = [];
    for (var i = 0; i < numPoints; i++) {
        var val = roundFloat(data.points[i], config.roundPrecision);
        // See if this norm is already known
        var index = data.values.indexOf(val);
        if (index === -1) {
            index = data.values.push(val) - 1;
        }
        data.pointsIndex.push(index);
    }
    delete data.points;
};

var indexShellNormals = function(data) {
    var numNormals = data.normals.length;
    var indexArray = [];
    for (var i = 0; i < numNormals; i++) {
        var val = roundFloat(data.normals[i], config.roundPrecision);
        // See if this norm is already known
        var index = data.values.indexOf(val);
        if (index === -1) {
            index = data.values.push(val) - 1;
        }
        indexArray.push(index);
    }
    data.normalsIndex = indexArray;
    delete data.normals;
};

var compressShellColors = function(data) {
    var numTuples = data.colors.length / 3;
    data.colorsData = [];
    var start = 0;
    var last = [
        data.colors[0],
        data.colors[1],
        data.colors[2]
    ];
    // Short list comparison
    function arraysIdentical(a, b) {
       return (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);
    }
    // Compress the rest
    for (var tuple = 1; tuple < numTuples; tuple++) {
        var index = tuple * 3;
        var tmp = [
            data.colors[index],
            data.colors[index + 1],
            data.colors[index + 2]
        ];
        // Is this a new block
        if (!arraysIdentical(last, tmp)) {
            data.colorsData.push({
                data: last,
                duration: tuple - start
            });
            start = tuple;
            last = tmp;
        }
    }
    // Push the final color block
    data.colorsData.push({
        data: last,
        duration: numTuples - start
    });
    // Remove the colors array
    delete data.colors;
//    console.log(JSON.stringify(data.colorsData));
};

/***********************************************************************/

var translateShell = function(shell) {
    // Do href here
    if (shell.attr("href")) {
        return {
            "id": shell.attr("id").value(),
            "size": parseInt(shell.attr("size").value()),
            "bbox": shell.attr("bbox").value().split(" ").map(function(val) { return parseFloat(val); }),
            "href":  shell.attr("href").value().replace("xml", "json")
        };
    // Convert XML point/vert/color to new way
    } else {
        translateTime = Date.now();
        var points = loadPoints(shell.find("verts"));
        var defaultColor = parseColor("7d7d7d");
        if (shell.attr("color")) {
            defaultColor = parseColor(shell.attr("color").value());
        }
        var data = {
            "id": shell.attr("id").value(),
            "size": 0,
            "points": [],
            "normals": [],
            "colors": []
        };
        _.forEach(shell.find("facets"), function(facet) {
            var color = _.clone(defaultColor);
            if (facet.attr("color")) {
                color = parseColor(facet.attr("color").value());
            }
            _.forEach(facet.find("f"), function(f) {
                // Get every vertex index and convert using points array
                var indexVals = f.attr("v").value().split(" ");
                var index0 = parseInt(indexVals[0]) * 3;
                var index1 = parseInt(indexVals[1]) * 3;
                var index2 = parseInt(indexVals[2]) * 3;

                data.points.push(parseFloat(points[index0]));
                data.points.push(parseFloat(points[index0 + 1]));
                data.points.push(parseFloat(points[index0 + 2]));
                data.points.push(parseFloat(points[index1]));
                data.points.push(parseFloat(points[index1 + 1]));
                data.points.push(parseFloat(points[index1 + 2]));
                data.points.push(parseFloat(points[index2]));
                data.points.push(parseFloat(points[index2 + 1]));
                data.points.push(parseFloat(points[index2 + 2]));

                // Get the vertex normals
                var norms = f.find("n");
                var normCoordinates = norms[0].attr("d").value().split(" ");
                data.normals.push(parseFloat(normCoordinates[0]));
                data.normals.push(parseFloat(normCoordinates[1]));
                data.normals.push(parseFloat(normCoordinates[2]));
                normCoordinates = norms[1].attr("d").value().split(" ");
                data.normals.push(parseFloat(normCoordinates[0]));
                data.normals.push(parseFloat(normCoordinates[1]));
                data.normals.push(parseFloat(normCoordinates[2]));
                normCoordinates = norms[2].attr("d").value().split(" ");
                data.normals.push(parseFloat(normCoordinates[0]));
                data.normals.push(parseFloat(normCoordinates[1]));
                data.normals.push(parseFloat(normCoordinates[2]));

                // Get the vertex colors
                data.colors.push(color.r);
                data.colors.push(color.g);
                data.colors.push(color.b);
                data.colors.push(color.r);
                data.colors.push(color.g);
                data.colors.push(color.b);
                data.colors.push(color.r);
                data.colors.push(color.g);
                data.colors.push(color.b);
            });
        });
        // Set the point data size
        data.size = data.points.length / 9;
        if (config.indexPoints || config.indexNormals || config.indexColors) {
            data.values = [];
            if (config.roundPrecision) {
                data.precision = config.roundPrecision;
            }
        }
        // Should we index the normals
        if (config.indexPoints) {
            indexShellPoints(data);
        }
        // Should we index the normals
        if (config.indexNormals) {
            indexShellNormals(data);
        }
        // Should we index the colors
        if (config.compressColors) {
            compressShellColors(data);
        }
        translateTime = Date.now() - translateTime;
        return data;
    }
};

function parseColor(hex) {
    var cval = parseInt(hex, 16);
    return {
        r: ((cval >>16) & 0xff) / 255,
        g: ((cval >>8) & 0xff) / 255,
        b: ((cval >>0) & 0xff) / 255
    };
}

function loadPoints(verts) {
    // Load all of the point information
    var points = [];
    _.forEach(verts, function(vert) {
        _.forEach(vert.find("v"), function(v) {
            var coords = v.attr("p").value().split(" ");
            points.push(coords[0]);
            points.push(coords[1]);
            points.push(coords[2]);
        });
    });
    return points;
}

/*************************************************************************/

function XMLTranslator() {
    this.parser = new xml2js.Parser();
}

XMLTranslator.prototype.parse = function(dir, filename, callback) {
    this.pathPrefix = dir + "/";
    var rootPath = this.pathPrefix + filename;
    // Read the root file
    readTime = Date.now();
    fs.readFile(rootPath, function(err, doc) {
        if (err) {
            callback(err);
        } else {
            parseTime = Date.now();
            readTime = parseTime - readTime;
            var results = libxmljs.parseXmlString(doc);
            parseTime = Date.now() - parseTime;
            callback(results.errors[0], results);
        }
    });
};

XMLTranslator.prototype.write = function(directory, filename, data, callback) {
    var path = directory + "/" + filename.replace("xml", "json");
    // Write the object to file
    fs.writeFile(path, JSON.stringify(data), function(err) {
        if (callback) callback(err, data);
    });
};

/*************************************************************************/

function showTimes() {
    console.log(argv.f + ": " +
        "(R: " + readTime + ", " +
        "P: " + parseTime + ", " +
        "T: " + translateTime + ", " +
        "W: " + writeTime + ")");
}




var argv = require('optimist')
    .default('d', '.')
    .default('f', 'index.xml')
    .default('b', 0)
    .argv;

var translator = new XMLTranslator();
// Translate the requested model file
translator.parse(argv.d, argv.f, function(err, data) {
    if (err) {
        console.log(err);
        return;
    }
    var root = data.root();
    // Is this is an assembly
    switch (root.name()) {
        case "step-assembly":
        case "assembly":
            writeTime = Date.now();
            translator.write(argv.d, argv.f, translateIndex(data, argv.b), function(err, data) {
                writeTime = Date.now() - writeTime;
                showTimes();
                // What is external
                var externalShells = _.pluck(data.shells, "href");
                var externalAnnotations = _.pluck(data.annotations, "href");
                // Push jobs to the workers
                async.eachLimit(externalShells, 8, function(shell, callback) {
                    shell = shell.replace("json", "xml");
                    var child = cp.fork("scripts/xmlToJson.js", ["-d", argv.d, "-f", shell]);
                    child.on("exit", function() {
                        callback();
                    });
                }, function() {
                        if (data.batches && data.batches > 0) {
                            console.log("Ready to batch");
                            batchShells(data, argv.d, translator);
                        }
                    }
                );
                _.forEach(externalAnnotations, function(annotation) {
                    annotation = annotation.replace("json", "xml");
                    cp.fork("scripts/xmlToJson.js", ["-d", argv.d, "-f", annotation]);
                });
            });
            break;
        case "shell":
            writeTime = Date.now();
            translator.write(argv.d, argv.f, translateShell(data.root()), function() {
                writeTime = Date.now() - writeTime;
                showTimes();
            });
            break;
        case "annotation":
            writeTime = Date.now();
            translator.write(argv.d, argv.f, translateAnnotation(data.root()), function() {
                writeTime = Date.now() - writeTime;
                showTimes();
            });
            break;
        default:
            console.log("Unknown XML file type");
    }
});
